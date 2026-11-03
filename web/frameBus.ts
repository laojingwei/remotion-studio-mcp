/**
 * 全局播放头总线：Player 的 frameupdate、时间轴 seek、3D 视口自己的播放循环
 * 都写这里，订阅方（时间轴播放头、3D 视口）从这里读。
 *
 * 值是**项目帧**（0..totalDuration-1）。3D 视口按自己幕的 sceneStart 换算幕内帧。
 * set 是同步广播：驱动方用 driving 守卫包住 set，避免收到自己的回声。
 *
 * 起因：3D 模式一度直接卸载 Player，时间轴的 seek/播放头全靠 playerRef——
 * 卸了就整条拖不动（实测踩过）。共享总线 + Player 隐藏挂载后，
 * 时间轴 seek、时间轴播放、视口自己的播放三种驱动互相跟手。
 *
 * `seek` 与 `set` 的区别：`set` 只广播"现在是第几帧"，`seek` 还要**请求**真正持有
 * Player 的一方去执行跳转（时间轴订阅了 seek）。属性面板的"跳到这个关键帧"没有
 * playerRef，只能发请求。
 */
type Listener = (frame: number) => void;

const listeners = new Set<Listener>();
const seekListeners = new Set<Listener>();
let current = 0;

export const frameBus = {
  get: () => current,
  set(next: number) {
    if (next === current) return;
    current = next;
    listeners.forEach((l) => l(next));
  },
  /** 请求跳帧：广播新帧号，并通知持有 Player 的一方执行 seekTo */
  seek(next: number) {
    const f = Math.max(0, Math.round(next));
    current = f;
    listeners.forEach((l) => l(f));
    seekListeners.forEach((l) => l(f));
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** 只有持有 Player 的地方需要订阅（时间轴） */
  onSeek(l: Listener) {
    seekListeners.add(l);
    return () => {
      seekListeners.delete(l);
    };
  },
};
