'use client';

import ErrorBoundary from '@/components/ErrorBoundary';
import RoutesContent from './RoutesContent';

export default function RoutesPage() {
  return (
    <ErrorBoundary>
      <RoutesContent />
    </ErrorBoundary>
  );
}
