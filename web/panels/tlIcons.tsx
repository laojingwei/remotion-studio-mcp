import React from "react";

/** 时间轴全局开关用的小图标（眼睛 / 声音），与轨道头一致 */
export const EyeOnIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 3l18 18" />
    <path d="M10.6 10.6a2 2 0 002.8 2.8" />
    <path d="M9.9 5.2A10.9 10.9 0 0112 5c6.5 0 10 7 10 7a18 18 0 01-3 3.8" />
    <path d="M6.6 6.6A18 18 0 002 12s3.5 7 10 7a10.7 10.7 0 004.2-.9" />
  </svg>
);

export const SoundOnIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9a4 4 0 010 6" />
  </svg>
);

export const SoundOffIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M17 9l4 6M21 9l-4 6" />
  </svg>
);
