/**
 * Login page — the wallet connect → sign → verify flow.
 *
 * This page is the one place in the dashboard where a bug is invisible from the
 * outside: it used to read `window.freighterApi` / `window.xBullSDK`, no package
 * was loaded to define either, so detection always failed and the page never
 * made a single request to the gateway ("wallet not found" every time) while
 * every API call behind it worked. The first test below is the regression guard
 * for exactly that: a click either reaches the gateway or it does not.
 *
 * The wallet SDKs are mocked because a jsdom run has no extension to talk to —
 * what is asserted is how the page *drives* them (lazily imported, same client
 * instance used for connect and sign, both signature shapes base64-encoded) and
 * what it sends to the gateway. The dev-mode fallback is exercised through the
 * real `@/lib/devMode` module, driven by `NEXT_PUBLIC_DEV_WALLET`, so the
 * fail-closed rules are not mocked away.
 *
 * Run: `pnpm exec nx test dashboard`
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as freighter from '@stellar/freighter-api';
import LoginPage from './page';
import { requestChallenge, verifyChallenge, setSessionToken, setWalletAddress } from '@/lib/api';

const ADDRESS = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const CHALLENGE = 'x402:login:2026-09-16T13:35:00.000Z:8f3c1a';
const CHALLENGE_ID = 'challenge-1';
const SESSION_TOKEN = 'session-token-1';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
  }),
}));

jest.mock('@/lib/api', () => ({
  requestChallenge: jest.fn(),
  verifyChallenge: jest.fn(),
  setSessionToken: jest.fn(),
  setWalletAddress: jest.fn(),
}));

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  requestAccess: jest.fn(),
  signMessage: jest.fn(),
}));

/**
 * xBull hands the page a session that must be reused for signing, so the mock
 * records the one instance the page constructs.
 */
const mockXBullClient = {
  connect: jest.fn(),
  signMessage: jest.fn(),
};

jest.mock('@creit.tech/xbull-wallet-connect', () => ({
  xBullWalletConnect: jest.fn(() => mockXBullClient),
}));

const freighterMock = jest.mocked(freighter);

/** Base64 the page should produce for a given signature payload. */
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** A wallet that is installed, returns `ADDRESS`, and signs with these bytes. */
function freighterSignsWith(
  signedMessage: string | Uint8Array,
  options: { address?: string } = {},
): void {
  freighterMock.isConnected.mockResolvedValue({ isConnected: true });
  freighterMock.requestAccess.mockResolvedValue({
    address: options.address ?? ADDRESS,
  } as never);
  freighterMock.signMessage.mockResolvedValue({ signedMessage } as never);
}

function gatewayAccepts(response: { token?: string } = {}): void {
  jest
    .mocked(requestChallenge)
    .mockResolvedValue({ challengeId: CHALLENGE_ID, challenge: CHALLENGE });
  jest.mocked(verifyChallenge).mockResolvedValue({
    verified: true,
    address: ADDRESS,
    token: SESSION_TOKEN,
    ...response,
  } as never);
}

const clickFreighter = () => fireEvent.click(screen.getByRole('button', { name: /Freighter/i }));
const clickXBull = () => fireEvent.click(screen.getByRole('button', { name: /xBull/i }));

describe('login page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` drops call history but keeps queued implementations, so a
    // wallet configured by one test would answer for the next one.
    freighterMock.isConnected.mockReset();
    freighterMock.requestAccess.mockReset();
    freighterMock.signMessage.mockReset();
    mockXBullClient.connect.mockReset();
    mockXBullClient.signMessage.mockReset();
    delete process.env.NEXT_PUBLIC_DEV_WALLET;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DEV_WALLET;
    jest.restoreAllMocks();
  });

  it('renders a connect button per supported wallet and no Albedo', () => {
    render(<LoginPage />);

    expect(screen.getByRole('button', { name: /Freighter/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /xBull/i })).toBeTruthy();
    // Albedo is deliberately absent: its message derivation is unpublished, so
    // the gateway cannot verify what it signs. See the page's connector notes.
    expect(screen.queryByRole('button', { name: /Albedo/i })).toBeNull();
  });

  describe('Freighter', () => {
    it('connects, signs the server challenge and completes sign-in', async () => {
      freighterSignsWith('c2lnbmF0dXJl');
      gatewayAccepts();

      render(<LoginPage />);
      clickFreighter();

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));

      // The address comes from the wallet SDK, and the challenge is requested
      // for it — this is the request the old global-reading page never made.
      expect(requestChallenge).toHaveBeenCalledWith(ADDRESS);
      // The challenge the *gateway* issued is what gets signed, not a local one.
      expect(freighterMock.signMessage).toHaveBeenCalledWith(CHALLENGE, { address: ADDRESS });
      expect(verifyChallenge).toHaveBeenCalledWith(CHALLENGE_ID, ADDRESS, 'c2lnbmF0dXJl');
      expect(setSessionToken).toHaveBeenCalledWith(SESSION_TOKEN);
      expect(setWalletAddress).toHaveBeenCalledWith(ADDRESS);
    });

    it('base64-encodes the signature in the shape older Freighter versions return', async () => {
      // v3 resolves a Uint8Array (a Buffer in the extension), v4 a base64 string.
      freighterSignsWith(new Uint8Array([1, 2, 3, 255]));
      gatewayAccepts();

      render(<LoginPage />);
      clickFreighter();

      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(verifyChallenge).toHaveBeenCalledWith(
        CHALLENGE_ID,
        ADDRESS,
        base64(new Uint8Array([1, 2, 3, 255])),
      );
    });

    it('completes sign-in from the session cookie alone when no token is returned', async () => {
      // Same-origin deployments authenticate with the httpOnly cookie the
      // gateway sets; the in-memory token is only the cross-origin fallback.
      freighterSignsWith('c2lnbmF0dXJl');
      gatewayAccepts({ token: undefined });

      render(<LoginPage />);
      clickFreighter();

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));
      expect(setSessionToken).not.toHaveBeenCalled();
      expect(setWalletAddress).toHaveBeenCalledWith(ADDRESS);
    });

    it('reports a missing wallet and never calls the gateway', async () => {
      freighterMock.isConnected.mockResolvedValue({ isConnected: false });

      render(<LoginPage />);
      clickFreighter();

      const error = await screen.findByText(/not detected in this browser/i);
      // The install hint is attached, so the message is actionable.
      expect(error.textContent).toContain('https://freighter.app');
      // The regression: no wallet must never mean a silent, request-free failure.
      expect(requestChallenge).not.toHaveBeenCalled();
      expect(verifyChallenge).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('surfaces an access error from the wallet instead of signing', async () => {
      freighterMock.isConnected.mockResolvedValue({ isConnected: true });
      freighterMock.requestAccess.mockResolvedValue({
        error: { message: 'User declined access' },
      } as never);

      render(<LoginPage />);
      clickFreighter();

      expect(await screen.findByText(/User declined access/)).toBeTruthy();
      expect(freighterMock.signMessage).not.toHaveBeenCalled();
      expect(requestChallenge).not.toHaveBeenCalled();
    });

    it('fails when the wallet reports no signature', async () => {
      freighterMock.isConnected.mockResolvedValue({ isConnected: true });
      freighterMock.requestAccess.mockResolvedValue({ address: ADDRESS } as never);
      freighterMock.signMessage.mockResolvedValue({} as never);

      render(<LoginPage />);
      clickFreighter();

      expect(await screen.findByText(/Freighter did not sign the challenge/i)).toBeTruthy();
      expect(verifyChallenge).not.toHaveBeenCalled();
    });
  });

  describe('xBull', () => {
    it('connects and signs through the same SDK client instance', async () => {
      mockXBullClient.connect.mockResolvedValue(ADDRESS);
      mockXBullClient.signMessage.mockResolvedValue({ signedMessage: 'eGJ1bGw=' });
      gatewayAccepts();

      render(<LoginPage />);
      clickXBull();

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));
      // One client per attempt: it holds the session the extension handshakes
      // over, so signing through a second instance would not be authorised.
      expect(mockXBullClient.connect).toHaveBeenCalled();
      expect(mockXBullClient.signMessage).toHaveBeenCalledWith(CHALLENGE, { address: ADDRESS });
      expect(verifyChallenge).toHaveBeenCalledWith(CHALLENGE_ID, ADDRESS, 'eGJ1bGw=');
      expect(setWalletAddress).toHaveBeenCalledWith(ADDRESS);
    });

    it('fails when xBull returns no signature', async () => {
      mockXBullClient.connect.mockResolvedValue(ADDRESS);
      mockXBullClient.signMessage.mockResolvedValue({});

      render(<LoginPage />);
      clickXBull();

      expect(await screen.findByText(/xBull did not sign the challenge/i)).toBeTruthy();
      expect(verifyChallenge).not.toHaveBeenCalled();
    });
  });

  describe('gateway rejection', () => {
    it('renders the gateway error and lets the user retry', async () => {
      freighterSignsWith('c2lnbmF0dXJl');
      jest
        .mocked(requestChallenge)
        .mockResolvedValue({ challengeId: CHALLENGE_ID, challenge: CHALLENGE });
      jest
        .mocked(verifyChallenge)
        .mockRejectedValue(new Error('Gateway error 401: {"message":"Invalid signature"}'));

      render(<LoginPage />);
      clickFreighter();

      // A rejected SEP-53/raw signature is what a real wallet used to get; the
      // failure has to reach the user rather than look like a hang.
      expect(await screen.findByText(/Invalid signature/)).toBeTruthy();
      expect(mockPush).not.toHaveBeenCalled();
      expect(setSessionToken).not.toHaveBeenCalled();

      // Dismissing leaves the page usable — the wallet buttons are enabled again.
      fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
      await waitFor(() => expect(screen.queryByText(/Invalid signature/)).toBeNull());
      expect(
        (screen.getByRole('button', { name: /Freighter/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  describe('dev-mode fallback', () => {
    it('falls back to the dev wallet and a dev signature when no wallet is installed', async () => {
      process.env.NEXT_PUBLIC_DEV_WALLET = ADDRESS;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      // A wallet that is genuinely absent: it cannot report an address, and it
      // cannot sign either.
      freighterMock.isConnected.mockResolvedValue({ isConnected: false });
      freighterMock.signMessage.mockRejectedValue(new Error('Freighter is not installed.'));
      gatewayAccepts();

      render(<LoginPage />);
      clickFreighter();

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));

      expect(requestChallenge).toHaveBeenCalledWith(ADDRESS);
      // The gateway accepts `dev-sig-` payloads only behind AUTH_DEV_MODE.
      const signature = jest.mocked(verifyChallenge).mock.calls[0][2];
      expect(atob(signature)).toMatch(new RegExp(`^dev-sig-${ADDRESS}-\\d+$`));
      // The fallback is never silent — it logs that it substituted an address.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Using the dev-mode address'));
    });

    it('does not arm the fallback when no dev wallet is configured', async () => {
      freighterMock.isConnected.mockResolvedValue({ isConnected: false });

      render(<LoginPage />);
      clickFreighter();

      expect(await screen.findByText(/not detected in this browser/i)).toBeTruthy();
      expect(verifyChallenge).not.toHaveBeenCalled();
    });
  });
});
