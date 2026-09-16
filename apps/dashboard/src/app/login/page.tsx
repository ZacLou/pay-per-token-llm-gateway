'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, ArrowRight, Shield, Loader2, AlertTriangle } from 'lucide-react';
import { requestChallenge, verifyChallenge, setSessionToken, setWalletAddress } from '@/lib/api';
import { getDevWalletAddress, isDevModeActive } from '@/lib/devMode';

type WalletType = 'freighter' | 'xbull';

interface WalletInfo {
  name: string;
  icon: typeof Wallet;
  color: string;
  type: WalletType;
  installUrl: string;
}

const wallets: WalletInfo[] = [
  {
    name: 'Freighter',
    icon: Wallet,
    color: 'from-green-500 to-emerald-600',
    type: 'freighter',
    installUrl: 'https://freighter.app',
  },
  {
    name: 'xBull',
    icon: Shield,
    color: 'from-blue-500 to-purple-600',
    type: 'xbull',
    installUrl: 'https://xbull.app',
  },
];

export default function LoginPage() {
  const router = useRouter();
  const [connecting, setConnecting] = useState<WalletType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'select' | 'signing' | 'verifying'>('select');

  const handleConnect = async (walletInfo: WalletInfo) => {
    setConnecting(walletInfo.type);
    setError(null);

    try {
      // Step 1: ask the wallet for an address.
      setStep('signing');
      const connector = await createConnector(walletInfo.type);
      const address = await addressOrDevFallback(walletInfo, () => connector.address());

      // Step 2: request a challenge from the gateway
      const { challengeId, challenge } = await requestChallenge(address);

      // Step 3: sign the challenge with the wallet. Both wallets sign it as a
      // SEP-53 message, which the gateway verifies (alongside the raw shape the
      // SDK/CLI signer produces).
      const signature = await signatureOrDevFallback(address, () =>
        connector.sign(challenge, address),
      );

      // Step 4: Verify with the gateway.
      // The gateway sets an httpOnly cookie (primary auth) and also returns
      // the token for in-memory cross-origin fallback.
      setStep('verifying');
      const { token } = await verifyChallenge(challengeId, address, signature);

      // Step 5: Store in-memory token (cross-origin fallback) + wallet address
      if (token) setSessionToken(token);
      setWalletAddress(address);

      router.push('/');
    } catch (err) {
      setError((err as Error).message);
      setStep('select');
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/icon.svg"
            alt="x402 Logo"
            className="w-20 h-20 mx-auto mb-4 rounded-2xl shadow-xl shadow-green-500/20"
          />
          <h1 className="text-2xl font-bold">x402 Gateway</h1>
          <p className="text-muted-foreground mt-2">
            Connect your Stellar wallet to manage your LLM endpoints
          </p>
        </div>

        {error && (
          <div className="card border-red-800/30 bg-red-950/10 mb-4">
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-red-900/20 rounded-lg shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-400" />
              </div>
              <div>
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setStep('select');
                  }}
                  className="text-xs text-green-400 hover:underline mt-1"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'verifying' && (
          <div className="card mb-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-green-400 animate-spin" />
              <div>
                <p className="text-sm font-medium">Verifying signature...</p>
                <p className="text-xs text-muted-foreground">Confirming with the gateway</p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {wallets.map((wallet) => (
            <button
              key={wallet.type}
              onClick={() => handleConnect(wallet)}
              disabled={connecting !== null}
              className="w-full flex items-center justify-between p-4 bg-card border border-border rounded-xl hover:border-green-800/50 transition-all disabled:opacity-50 group"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg bg-gradient-to-br ${wallet.color} flex items-center justify-center`}
                >
                  {connecting === wallet.type ? (
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                  ) : (
                    <wallet.icon className="w-5 h-5 text-white" />
                  )}
                </div>
                <div className="text-left">
                  <span className="font-medium">{wallet.name}</span>
                  <p className="text-xs text-muted-foreground">Stellar browser wallet</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-green-400 transition-colors" />
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground text-center mt-6">
          Don&apos;t have a wallet?{' '}
          <a
            href="https://freighter.app"
            target="_blank"
            className="text-green-400 hover:underline"
          >
            Install Freighter
          </a>
        </p>
      </div>
    </div>
  );
}

// ── Wallet Connectors ────────────────────────
//
// Each wallet is reached through its own npm package, imported lazily so the
// libraries only load when a visitor actually connects:
//
//   Freighter → @stellar/freighter-api
//   xBull     → @creit.tech/xbull-wallet-connect
//
// Reading a global instead (`window.freighterApi`, `window.xBullSDK`) does not
// work for an app built with a bundler, which is what this page used to do — so
// it never made a single request to the gateway: no package was loaded to
// define those globals, the detection returned null, and the click ended in
// "wallet not found". `window.freighterApi` exists only when the library is
// loaded from a CDN <script> tag, and `window.xBullSDK` only inside the xBull
// extension's own injected context (the SDK in this repo talks to it).
//
// Albedo is absent on purpose: `albedo.signMessage` returns a signature over a
// message Albedo derives from the public key and the original text (its
// `signed_message` field, hex), and that derivation is not published anywhere,
// so the gateway cannot check it. Verifying just the returned signature over
// the client-supplied bytes would make a captured signature replayable as a
// login. Adding Albedo needs its derivation, not another button.

interface WalletConnector {
  /** Resolve the user's address, prompting the wallet if needed. */
  address(): Promise<string>;
  /** Sign the challenge; returns a base64 signature. */
  sign(challenge: string, address: string): Promise<string>;
}

/**
 * Base64 for the byte shapes wallets return. Freighter's `signMessage` is a
 * base64 string in v4 of its API and a Buffer in v3, so both are handled
 * without importing Node's Buffer into the browser bundle.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Prompt the wallet, or fall back to dev mode when it is armed. */
async function addressOrDevFallback(wallet: WalletInfo, connect: () => Promise<string>) {
  try {
    const address = await connect();
    if (!address) throw new Error(`${wallet.name} did not return an address.`);
    return address;
  } catch (err) {
    const devWallet = getDevWalletAddress();
    if (devWallet && isDevModeActive()) {
      console.warn(
        `[x402] ${wallet.name} unavailable (${(err as Error).message}). Using the dev-mode address.`,
      );
      return devWallet;
    }
    throw new Error(
      `${(err as Error).message} Install ${wallet.name} from ${wallet.installUrl} and reload.`,
    );
  }
}

/** Sign, or produce a dev-mode signature when the fallback is armed. */
async function signatureOrDevFallback(address: string, sign: () => Promise<string>) {
  try {
    const signature = await sign();
    if (!signature) throw new Error('the wallet did not return a signature');
    return signature;
  } catch (err) {
    if (isDevModeActive()) {
      console.warn(
        `[x402] Signing failed (${(err as Error).message}). Using a dev-mode signature.`,
      );
      // btoa rather than Buffer: that is the same base64 the gateway's
      // `dev-sig-` check decodes, without a Node global in the browser bundle.
      return btoa(`dev-sig-${address}-${Date.now()}`);
    }
    throw err;
  }
}

async function createConnector(type: WalletType): Promise<WalletConnector> {
  if (type === 'freighter') {
    const { isConnected, requestAccess, signMessage } = await import('@stellar/freighter-api');

    return {
      async address() {
        const status = await isConnected();
        if (!status.isConnected) throw new Error('Freighter was not detected in this browser.');
        const access = await requestAccess();
        if (access.error) throw new Error(access.error.message);
        return access.address;
      },
      async sign(challenge, address) {
        const result = await signMessage(challenge, { address });
        if (result.error) throw new Error(result.error.message);
        const { signedMessage } = result;
        if (!signedMessage) throw new Error('Freighter did not sign the challenge.');
        return typeof signedMessage === 'string' ? signedMessage : toBase64(signedMessage);
      },
    };
  }

  const { xBullWalletConnect } = await import('@creit.tech/xbull-wallet-connect');
  // One client per connect attempt: it holds the session the extension
  // handshakes over, so signing has to go through the same instance.
  const client = new xBullWalletConnect();

  return {
    async address() {
      return client.connect();
    },
    async sign(challenge, address) {
      const { signedMessage } = await client.signMessage(challenge, { address });
      if (!signedMessage) throw new Error('xBull did not sign the challenge.');
      return signedMessage;
    },
  };
}
