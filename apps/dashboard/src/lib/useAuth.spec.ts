/**
 * useAuth — the session-check-and-expose hook.
 *
 * useAuth is the only place the dashboard decides whether the user is signed
 * in: it calls the gateway's `/auth/session`, stores the address, and exposes
 * a global `isAuthenticated()` that data-fetching hooks consult outside the
 * React tree. A bug here means every page either shows "not logged in" or
 * never logs out.
 *
 * Run: `pnpm exec nx test dashboard`
 */

// React 19 requires this flag for act() support in tests.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { validateSession, endSession, getWalletAddress } from './api';
import { useAuth, isAuthenticated } from './useAuth';

jest.mock('./api', () => ({
  validateSession: jest.fn(),
  endSession: jest.fn(),
  getWalletAddress: jest.fn(),
}));

const ADDRESS = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

describe('useAuth', () => {
  it('sets the address when the gateway session is valid', async () => {
    jest.mocked(validateSession).mockResolvedValue({ address: ADDRESS } as never);
    jest.mocked(getWalletAddress).mockReturnValue(null);

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.address).toBe(ADDRESS);
    expect(result.current.isConnected).toBe(true);
  });

  it('reads a stored address instantly while the gateway check runs', async () => {
    // A stored address gives instant UI feedback; the gateway check replaces
    // or clears it. The hook must not flash "disconnected" in between.
    jest.mocked(getWalletAddress).mockReturnValue(ADDRESS);
    jest.mocked(validateSession).mockResolvedValue({ address: ADDRESS } as never);

    const { result } = renderHook(() => useAuth());

    // Before the gateway responds, the stored address is already visible.
    expect(result.current.address).toBe(ADDRESS);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isConnected).toBe(true);
  });

  it('clears the address when the gateway session is invalid', async () => {
    jest.mocked(getWalletAddress).mockReturnValue(ADDRESS);
    jest.mocked(validateSession).mockRejectedValue(new Error('no session'));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it('disconnect clears local state and calls endSession', async () => {
    jest.mocked(validateSession).mockResolvedValue({ address: ADDRESS } as never);
    jest.mocked(getWalletAddress).mockReturnValue(null);
    jest.mocked(endSession).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(endSession).toHaveBeenCalled();
    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(localStorage.getItem('x402-wallet-address')).toBeNull();
  });

  it('disconnect clears local state even when endSession throws', async () => {
    jest.mocked(validateSession).mockResolvedValue({ address: ADDRESS } as never);
    jest.mocked(getWalletAddress).mockReturnValue(null);
    jest.mocked(endSession).mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.address).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });
});

describe('isAuthenticated global', () => {
  it('starts false and becomes true after a successful session check', async () => {
    expect(isAuthenticated()).toBe(false);

    jest.mocked(validateSession).mockResolvedValue({ address: ADDRESS } as never);
    jest.mocked(getWalletAddress).mockReturnValue(null);

    renderHook(() => useAuth());

    await waitFor(() => expect(isAuthenticated()).toBe(true));
  });

  it('stays false when the session check fails', async () => {
    jest.mocked(validateSession).mockRejectedValue(new Error('no session'));
    jest.mocked(getWalletAddress).mockReturnValue(null);

    renderHook(() => useAuth());

    // Give the hook time to run and fail.
    await new Promise((r) => setTimeout(r, 50));
    expect(isAuthenticated()).toBe(false);
  });
});
