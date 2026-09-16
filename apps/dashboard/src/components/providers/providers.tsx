'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createQueryClient } from '@/lib/query-client';

export function Providers({ children }: { children: React.ReactNode }) {
  // See lib/query-client.ts: a 401 must not be retried or thrown, or a
  // signed-out visitor gets a retry storm and the error boundary instead of the
  // Connect Wallet state each page already implements.
  const [queryClient] = useState(createQueryClient);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
