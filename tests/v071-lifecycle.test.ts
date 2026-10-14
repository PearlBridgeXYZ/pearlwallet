import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/broadcast-env';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('v0.7.1 lifecycle regressions', () => {
  it('locks immediately even if worker RPC never responds', async () => {
    const { useWallet } = await import('../src/state/wallet-store');
    const { cryptoWorker } = await import('../src/crypto/worker-client');
    const call = vi.spyOn(cryptoWorker, 'call').mockImplementation(() => new Promise(() => {}));
    const reset = vi.spyOn(cryptoWorker, 'reset').mockImplementation(() => {});
    useWallet.setState({ status: 'unlocked', addresses: { pearl: 'test', eth: '0x123' } as never });
    const locking = useWallet.getState().lock();
    expect(useWallet.getState().status).toBe('locked');
    expect(useWallet.getState().addresses).toBeNull();
    expect(reset).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
    await locking;
  });
  it('locks the wallet when the worker fails', async () => {
    const { useWallet } = await import('../src/state/wallet-store');
    const { cryptoWorker } = await import('../src/crypto/worker-client');
    useWallet.setState({status:'unlocked', addresses:{pearl:'test',eth:'0x123'} as never});
    cryptoWorker.reset('E_WORKER_ERROR');
    expect(useWallet.getState().status).toBe('locked');
    expect(useWallet.getState().addresses).toBeNull();
  });
  it.each([1, 4, 5, 6, 7])('preserves explicit opt-outs from preference version %i', async (v) => {
    vi.resetModules();
    const storage = memoryStorage();
    storage.setItem(`pearl-wallet-ui-v${v}`, JSON.stringify({tipEnabled:false,ethEnabled:false,multisigEnabled:false,theme:'dark'}));
    vi.stubGlobal('localStorage', storage);
    const { useUI } = await import('../src/state/ui-store');
    expect(useUI.getState()).toMatchObject({tipEnabled:false,ethEnabled:false,multisigEnabled:false,theme:'dark'});
  });
  it('preserves loaded opt-outs even when saving migration fails', async () => {
    vi.resetModules(); const storage = memoryStorage();
    storage.setItem('pearl-wallet-ui-v6', JSON.stringify({tipEnabled:false,ethEnabled:false,theme:'dark'}));
    vi.spyOn(storage,'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.stubGlobal('localStorage',storage);
    const {useUI}=await import('../src/state/ui-store');
    expect(useUI.getState()).toMatchObject({tipEnabled:false,ethEnabled:false,theme:'dark'});
  });
  it('ignores malformed persisted field types and unknown fields', async () => {
    vi.resetModules(); const storage = memoryStorage();
    storage.setItem('pearl-wallet-ui-v7', JSON.stringify({tipEnabled:'false',theme:'unknown',ethRpcOverride:42,extra:true}));
    vi.stubGlobal('localStorage', storage);
    const { useUI } = await import('../src/state/ui-store');
    expect(useUI.getState()).toMatchObject({tipEnabled:true,theme:'system',ethRpcOverride:''});
    expect(useUI.getState()).not.toHaveProperty('extra');
  });
});
