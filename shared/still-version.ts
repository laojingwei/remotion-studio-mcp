/**
 * 缩略图版本戳 —— **由出图脚本自动刷新，勿手改**。
 *
 * 图片 URL 原本是 /api/.../still/<id>，永远不变，而响应给过 max-age=604800；
 * 重出图后浏览器 7 天内连条件请求都不发，用户看到的仍是旧图。
 * 现在 URL 带 ?v=<这个戳>：内容一变戳就变，URL 就变，浏览器必然重新取。
 * 戳汇总了内置风格样张与提示词缩略图两类资源，算法见 scripts/still-version.mts。
 */
export const STILL_VERSION = "cda89fea4ca5";
