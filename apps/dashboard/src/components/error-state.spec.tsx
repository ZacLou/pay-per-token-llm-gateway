/**
 * ErrorState — the reusable data-fetch error card.
 *
 * Every data-fetching dashboard page renders this component when a query fails.
 * It has two visual modes: a generic error (red, with Retry) and an
 * authentication error (amber, with a Connect Wallet CTA). Getting either
 * wrong means the user sees either a broken page with no recovery path or
 * a misleading "log in again" prompt on a real server error.
 *
 * Run: `pnpm exec nx test dashboard`
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorState } from './error-state';

describe('ErrorState', () => {
  it('renders the title and message', () => {
    render(<ErrorState title="Failed to load" message="Network timeout" />);

    expect(screen.getByText('Failed to load')).toBeTruthy();
    expect(screen.getByText('Network timeout')).toBeTruthy();
  });

  it('renders a Retry button that fires onRetry', () => {
    const onRetry = jest.fn();
    render(<ErrorState title="Error" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses a custom retry label when provided', () => {
    render(<ErrorState title="Error" onRetry={jest.fn()} retryLabel="Reload" />);

    expect(screen.getByRole('button', { name: /Reload/i })).toBeTruthy();
  });

  it('hides the Retry button when no onRetry is provided', () => {
    render(<ErrorState title="Error" />);

    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
  });

  describe('unauthenticated mode', () => {
    it('renders a Connect Wallet link instead of Retry', () => {
      render(
        <ErrorState
          title="Authentication required"
          message="Your session expired"
          unauthenticated
        />,
      );

      const link = screen.getByRole('link', { name: /Connect Wallet/i });
      expect(link).toBeTruthy();
      expect((link as HTMLAnchorElement).getAttribute('href')).toBe('/login');
      expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
    });

    it('does not call onRetry when unauthenticated', () => {
      const onRetry = jest.fn();
      render(<ErrorState title="Auth required" onRetry={onRetry} unauthenticated />);

      // There is no Retry button to click.
      expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
      expect(onRetry).not.toHaveBeenCalled();
    });
  });
});
