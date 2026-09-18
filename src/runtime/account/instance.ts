export const getAccountOwnership = (): any => ({ release: () => {} });
export const initAccountOwnership = (): any => ({ acquire: () => ({ ok: false, errorCode: 'ACCOUNT_COOLDOWN' as const }) });
export const isLeaseAuthorityEnabled = (): boolean => false;
export const toLegacyAccountLease = (_: any) => ({ leaseId: '', accountId: '', release: () => {} });
