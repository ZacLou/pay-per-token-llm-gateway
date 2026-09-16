/**
 * Escrow page — the prepaid credit-escrow balance checker.
 *
 * The escrow page lets a user look up their on-chain prepaid balance by
 * Stellar address. It calls `fetchEscrowBalance` directly (not through
 * React Query), so the test exercises the full form → fetch → render
 * cycle including the loading spinner and error states.
 *
 * Run: `pnpm exec nx test dashboard`
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchEscrowBalance } from '@/lib/api';
import EscrowPage from './page';

jest.mock('@/lib/api', () => ({
  fetchEscrowBalance: jest.fn(),
}));

const ADDRESS = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('escrow page', () => {
  it('renders an address input and a Check button', () => {
    render(<EscrowPage />);

    expect(screen.getByPlaceholderText(/Stellar address/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Check/i })).toBeTruthy();
  });

  it('fetches and displays the balance on submit', async () => {
    jest.mocked(fetchEscrowBalance).mockResolvedValue({
      address: ADDRESS,
      balance: '5.0000000',
      asset: 'USDC',
      contractId: 'CABC123',
    });

    render(<EscrowPage />);

    const input = screen.getByPlaceholderText(/Stellar address/i);
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: /Check/i }));

    await waitFor(() => expect(screen.getByText('5.0000000')).toBeTruthy());

    expect(fetchEscrowBalance).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByText('USDC')).toBeTruthy();
    expect(screen.getByText('CABC123')).toBeTruthy();
  });

  it('displays an error when the fetch fails', async () => {
    jest.mocked(fetchEscrowBalance).mockRejectedValue(new Error('Account not found'));

    render(<EscrowPage />);

    const input = screen.getByPlaceholderText(/Stellar address/i);
    fireEvent.change(input, { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: /Check/i }));

    await waitFor(() => expect(screen.getByText('Account not found')).toBeTruthy());
  });

  it('disables the Check button while loading', async () => {
    // Never resolve the fetch so we can observe the loading state.
    jest.mocked(fetchEscrowBalance).mockReturnValue(
      new Promise((_resolve, _reject) => {
        /* never resolves */
      }),
    );

    render(<EscrowPage />);

    const input = screen.getByPlaceholderText(/Stellar address/i);
    fireEvent.change(input, { target: { value: ADDRESS } });

    const button = screen.getByRole('button', { name: /Check/i });
    fireEvent.click(button);

    await waitFor(() => expect(button.getAttribute('disabled')).not.toBeNull());
  });

  it('does not submit when the address is empty', () => {
    render(<EscrowPage />);

    const button = screen.getByRole('button', { name: /Check/i });
    // The button should be disabled when the input is empty.
    expect(button.getAttribute('disabled')).not.toBeNull();
  });
});
