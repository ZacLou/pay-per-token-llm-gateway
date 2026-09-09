'use client';

import { useRouter } from 'next/navigation';
import { useRoutes } from '@/lib/hooks';
import Skeleton from '@/components/Skeleton';
import { ApiError } from '@/lib/api';

export default function RoutesContent() {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useRoutes();

  if (isLoading) return <Skeleton />;

  if (isError) {
    let errorMessage = 'Error loading routes';
    let actionLabel = 'Retry';
    let redirect = false;

    if (error instanceof ApiError) {
      const status = Number(error.status); // Ensure status is treated as a number
      switch (status) {
        case 401:
          errorMessage = 'Session expired. Please re-authenticate.';
          actionLabel = 'Login';
          redirect = true;
          break;
        case 500:
          errorMessage = 'Server error. Please try again later.';
          break;
        case 0:
          errorMessage = 'Network error. Check your connection.';
          break;
        default:
          errorMessage = error.message;
      }
    }

    const handleAction = () => {
      if (redirect) {
        router.push('/auth');
      } else {
        refetch();
      }
    };

    return (
      <div className="error-state p-4 text-red-500">
        <h3 className="text-lg font-semibold">{errorMessage}</h3>
        <button 
          onClick={handleAction}
          className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          {actionLabel}
        </button>
      </div>
    );
  }

  // Render actual routes content
  return (
    <div className="routes-container">
      {/* Your existing routes UI */}
    </div>
  );
}
