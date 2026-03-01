/**
 * API 辅助函数模块
 * @module api/helpers
 */

import { sha256Hex } from '../utils/common.js';

/**
 * 从请求中提取 JWT 载荷
 * @param {Request} request - HTTP 请求对象
 * @param {object} options - 选项对象
 * @returns {object|null} JWT 载荷或 null
 */
export function getJwtPayload(request, options = {}) {
  // 优先使用服务端传入的已解析身份（支持 __root__ 超管）
  if (options && options.authPayload) return options.authPayload;
  try {
    const cookie = request.headers.get('Cookie') || '';
    const token = (cookie.split(';').find(s => s.trim().startsWith('iding-session=')) || '').split('=')[1] || '';
    const parts = token.split('.');
    if (parts.length === 3) {
      const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(json);
    }
  } catch (_) { }
  return null;
}

/**
 * 检查是否为严格管理员
 * @param {Request} request - HTTP 请求对象
 * @param {object} options - 选项对象
 * @returns {boolean} 是否为严格管理员
 */
export function isStrictAdmin(request, options = {}) {
  const p = getJwtPayload(request, options);
  if (!p) return false;
  if (p.role !== 'admin') return false;
  // __root__（根管理员）视为严格管理员
  if (String(p.username || '') === '__root__') return true;
  // 修复：adminName 未设定时不应将所有 admin 视为严格管理员
  if (!options?.adminName) return false;
  return String(p.username || '').toLowerCase() === String(options.adminName).toLowerCase();
}

/**
 * 创建标准 JSON 响应
 * @param {any} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @returns {Response} HTTP 响应对象
 */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 创建错误响应
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @returns {Response} HTTP 响应对象
 */
export function errorResponse(message, status = 400) {
  return new Response(message, { status });
}

// B8: 標準化錯誤回應
export const ERR = {
  BAD_REQUEST: (msg = '请求参数错误') => errorResponse(msg, 400),
  UNAUTHORIZED: (msg = '未登录或登录已过期') => errorResponse(msg, 401),
  FORBIDDEN: (msg = '无权限执行此操作') => errorResponse(msg, 403),
  NOT_FOUND: (msg = '资源不存在') => errorResponse(msg, 404),
  RATE_LIMITED: (msg = '请求过于频繁，请稍后再试') => errorResponse(msg, 429),
  SERVER_ERROR: (msg = '服务器内部错误') => errorResponse(msg, 500),
};

export { sha256Hex };

// B6: 統一分頁回應格式
export function paginatedResponse(list, total, page = 1, size = 20) {
  return Response.json({
    list: list || [],
    total: total || 0,
    page,
    size,
    hasMore: total > page * size
  });
}
