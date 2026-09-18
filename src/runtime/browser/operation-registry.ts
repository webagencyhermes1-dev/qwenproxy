export const operationRegistry = { 
  remove: (_: string) => {}, 
  register: (_: any) => ({ 
    operationId: '', 
    accountId: '', 
    resolveCompletion: () => {}, 
    controller: { 
      signal: { 
        aborted: false, 
        addEventListener: (_type: string, _listener: () => void, _options?: any) => {} 
      }, 
      abort: () => {} 
    }, 
    deadline: 0 
  }) 
};
export const browserOwnershipEnabled = (): boolean => false;
export type RegisteredOperation = { 
  operationId: string; 
  accountId: string; 
  resolveCompletion: () => void; 
  controller: { 
    signal: { 
      aborted: boolean; 
      addEventListener: (_type: string, _listener: () => void, _options?: any) => void; 
    }; 
    abort: () => void; 
  }; 
  deadline: number; 
};
