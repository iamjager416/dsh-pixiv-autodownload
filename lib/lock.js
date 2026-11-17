/**
 * 全局同步锁：定时器、工具、设置页按钮共用，避免同一时间跑两轮。
 */

export const lock = { busy: false }
