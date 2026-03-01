/**
 * Freemail 主入口文件
 * 
 * 本文件作为 Cloudflare Worker 的入口点，负责：
 * 1. 处理 HTTP 请求（通过 fetch 处理器）
 * 2. 处理邮件接收（通过 email 处理器）
 * 
 * 所有具体业务逻辑已拆分到各个子模块中
 * 
 * @module server
 */

import { initDatabase, getInitializedDatabase } from './db/index.js';
import { createRouter, authMiddleware } from './routes/index.js';
import { createAssetManager } from './assets/index.js';
import { extractEmail } from './utils/common.js';
import { forwardByLocalPart, forwardByMailboxConfig } from './email/forwarder.js';
import { parseEmailBody, extractVerificationCode } from './email/parser.js';
import { getForwardTarget } from './db/mailboxes.js';

export default {
  /**
   * HTTP请求处理器
   * @param {Request} request - HTTP请求对象
   * @param {object} env - 环境变量对象
   * @param {object} ctx - 上下文对象
   * @returns {Promise<Response>} HTTP响应对象
   */
  async fetch(request, env, ctx) {
    // 获取数据库连接
    let DB;
    try {
      DB = await getInitializedDatabase(env);
    } catch (error) {
      console.error('数据库连接失败:', error.message);
      return new Response('数据库连接失败，请检查配置', { status: 500 });
    }

    // 解析邮件域名
    const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
      .split(/[,\s]+/)
      .map(d => d.trim())
      .filter(Boolean);

    // 创建路由器并添加认证中间件
    const router = createRouter();
    router.use(authMiddleware);

    // 尝试使用路由器处理请求
    const routeResponse = await router.handle(request, { request, env, ctx });
    if (routeResponse) {
      return routeResponse;
    }

    // 使用资源管理器处理静态资源请求
    const assetManager = createAssetManager();
    return await assetManager.handleAssetRequest(request, env, MAIL_DOMAINS);
  },

  /**
   * 邮件接收处理器
   * @param {object} message - 邮件消息对象
   * @param {object} env - 环境变量对象
   * @param {object} ctx - 上下文对象
   * @returns {Promise<void>}
   */
  async email(message, env, ctx) {
    // 获取数据库连接
    let DB;
    try {
      DB = await getInitializedDatabase(env);
    } catch (error) {
      console.error('邮件处理时数据库连接失败:', error.message);
      return;
    }

    try {
      // 解析邮件头部
      const headers = message.headers;
      const toHeader = headers.get('to') || headers.get('To') || '';
      const fromHeader = headers.get('from') || headers.get('From') || '';
      const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

      // 解析收件人地址
      let envelopeTo = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue) && toValue.length > 0) {
          envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
        } else if (typeof toValue === 'string') {
          envelopeTo = toValue;
        }
      } catch (_) { }

      const resolvedRecipient = (envelopeTo || toHeader || '').toString();
      const resolvedRecipientAddr = extractEmail(resolvedRecipient);
      const localPart = (resolvedRecipientAddr.split('@')[0] || '').toLowerCase();

      // 处理邮件转发（优先使用邮箱配置，否则使用全局规则）
      const mailboxForwardTo = await getForwardTarget(DB, resolvedRecipientAddr);
      if (mailboxForwardTo) {
        forwardByMailboxConfig(message, mailboxForwardTo, ctx);
      } else {
        forwardByLocalPart(message, localPart, ctx, env);
      }

      // 读取原始邮件内容（限制解析大小防止 CPU 超时）
      const MAX_PARSE_SIZE = 256 * 1024; // B2: 256KB 限制
      let textContent = '';
      let htmlContent = '';
      let rawBuffer = null;
      try {
        const resp = new Response(message.raw);
        rawBuffer = await resp.arrayBuffer();
        const rawText = (await new Response(rawBuffer).text()).slice(0, MAX_PARSE_SIZE);
        const parsed = parseEmailBody(rawText);
        textContent = parsed.text || '';
        htmlContent = parsed.html || '';
        if (!textContent && !htmlContent) textContent = (rawText || '').slice(0, 100000);
      } catch (_) {
        textContent = '';
        htmlContent = '';
      }

      const mailbox = extractEmail(resolvedRecipient || toHeader);
      const sender = extractEmail(fromHeader);

      // 生成预览和验证码（同步，轻量操作）
      const preview = (() => {
        const plain = textContent && textContent.trim() ? textContent : (htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return String(plain || '').slice(0, 120);
      })();
      let verificationCode = '';
      try {
        verificationCode = extractVerificationCode({ subject, text: textContent, html: htmlContent });
      } catch (_) { }

      // 解析收件人列表
      let toAddrs = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue)) {
          toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
        } else if (typeof toValue === 'string') {
          toAddrs = toValue;
        } else {
          toAddrs = resolvedRecipient || toHeader || '';
        }
      } catch (_) {
        toAddrs = resolvedRecipient || toHeader || '';
      }

      // B1: 使用 ctx.waitUntil 包裹非關鍵的 R2 + D1 寫入操作
      ctx.waitUntil((async () => {
        try {
          // R2 存储
          const r2 = env.MAIL_EML;
          let objectKey = '';
          try {
            const now = new Date();
            const y = now.getUTCFullYear();
            const m = String(now.getUTCMonth() + 1).padStart(2, '0');
            const d = String(now.getUTCDate()).padStart(2, '0');
            const hh = String(now.getUTCHours()).padStart(2, '0');
            const mm = String(now.getUTCMinutes()).padStart(2, '0');
            const ss = String(now.getUTCSeconds()).padStart(2, '0');
            const keyId = (globalThis.crypto?.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
            objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
            if (r2 && rawBuffer) {
              await r2.put(objectKey, new Uint8Array(rawBuffer), { httpMetadata: { contentType: 'message/rfc822' } });
            }
          } catch (e) {
            console.error('R2 put failed:', e);
          }

          // D1 存储
          const normalizedMailbox = (mailbox || '').toLowerCase();
          const [localPartMb, domain] = normalizedMailbox.split('@');
          if (localPartMb && domain) {
            await DB.prepare('INSERT OR IGNORE INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
              .bind(normalizedMailbox, localPartMb, domain).run();
          }
          const resMb = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(normalizedMailbox).all();
          const mailboxId = resMb?.results?.[0]?.id;
          if (!mailboxId) { console.error('无法解析或创建 mailbox 记录'); return; }

          await DB.prepare(`
            INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mailboxId,
            sender,
            String(toAddrs || ''),
            subject || '(无主题)',
            verificationCode || null,
            preview || null,
            'mail-eml',
            objectKey || ''
          ).run();
        } catch (e) {
          console.error('Background storage failed:', e);
        }
      })());
    } catch (err) {
      console.error('Email event handling error:', err);
      // B5: 處理失敗時退信，讓寄件方 MTA 自動重試
      try { message.setReject('Temporary failure, please retry later.'); } catch (_) {}
    }
  },

  /**
   * 定時任務處理器 - 自動清理超過 24 小時的郵件
   * @param {ScheduledEvent} event - 定時事件
   * @param {object} env - 環境變數
   * @param {object} ctx - 上下文
   */
  async scheduled(event, env, ctx) {
    let DB;
    try {
      DB = await getInitializedDatabase(env);
    } catch (error) {
      console.error('定時清理：資料庫連線失敗:', error.message);
      return;
    }

    const r2 = env.MAIL_EML;
    const retentionHours = parseInt(env.MAIL_RETENTION_HOURS, 10) || 24;
    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();

    try {
      // 1. 取得即將刪除的郵件的 R2 keys
      let r2Keys = [];
      try {
        const msgs = await DB.prepare(
          "SELECT r2_object_key FROM messages WHERE received_at < ? AND r2_object_key != ''"
        ).bind(cutoff).all();
        r2Keys = (msgs?.results || []).map(r => r.r2_object_key).filter(Boolean);
      } catch (_) {}

      // 2. 刪除過期郵件記錄
      const result = await DB.prepare('DELETE FROM messages WHERE received_at < ?').bind(cutoff).run();
      const deletedCount = result?.meta?.changes || 0;

      // 3. 非同步清理 R2 檔案（批次處理，每批 100 個）
      if (r2 && r2Keys.length > 0) {
        for (let i = 0; i < r2Keys.length; i += 100) {
          const batch = r2Keys.slice(i, i + 100);
          await Promise.all(batch.map(key => r2.delete(key).catch(() => {})));
        }
      }

      // 4. 清理無郵件的空郵箱（可選，保留有使用者綁定的）
      try {
        await DB.prepare(`
          DELETE FROM mailboxes 
          WHERE id NOT IN (SELECT DISTINCT mailbox_id FROM messages)
            AND id NOT IN (SELECT DISTINCT mailbox_id FROM user_mailboxes)
            AND last_accessed_at < ?
        `).bind(cutoff).run();
      } catch (_) {}

      console.log(`定時清理完成：刪除 ${deletedCount} 封郵件，清理 ${r2Keys.length} 個 R2 檔案`);
    } catch (error) {
      console.error('定時清理失敗:', error);
    }
  }
};
