export const getRuntimeMode = (): string => process.env.QWEN_RUNTIME_MODE ?? 'production';
export const isRuntimeMode = (): boolean => getRuntimeMode() !== 'legacy';
