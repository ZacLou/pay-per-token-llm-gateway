'use client';

import { useState } from 'react';
import { Bell, CheckCheck, MailOpen } from 'lucide-react';
import Skeleton from '../../components/Skeleton';
import { ErrorState } from '../../components/error-state';
import { isUnauthenticatedError } from '../../lib/api';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
} from '../../lib/hooks';

const EVENT_LABELS: Record<string, string> = {
  payment_received: 'Payment received',
  verification_failed: 'Verification failed',
  request_forwarded: 'Request forwarded',
};

function eventLabel(event: string): string {
  return EVENT_LABELS[event] || event;
}

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading, isError, error, refetch } = useNotifications({ unreadOnly });
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unauthenticated = isError && isUnauthenticatedError(error);
  const notifications = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="w-6 h-6 text-green-400" />
            Notifications
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            In-app events persisted in PostgreSQL for your providers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setUnreadOnly((v) => !v)}
            className={`text-sm px-3 py-2 rounded-lg border transition-colors ${
              unreadOnly
                ? 'border-green-800/40 bg-green-900/20 text-green-400'
                : 'border-border text-gray-300 hover:bg-gray-800/50'
            }`}
          >
            {unreadOnly ? 'Showing unread' : 'Show unread only'}
          </button>
          <button
            onClick={() => markAllRead.mutate(undefined)}
            disabled={markAllRead.isPending || (data?.unread ?? 0) === 0}
            className="inline-flex items-center gap-1.5 text-sm bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition-colors"
          >
            <CheckCheck className="w-4 h-4" />
            Mark all read
          </button>
        </div>
      </div>

      {isLoading && <Skeleton />}

      {isError && (
        <ErrorState
          title="Could not load notifications"
          message={(error as Error)?.message}
          onRetry={() => refetch()}
          unauthenticated={unauthenticated}
        />
      )}

      {!isLoading && !isError && notifications.length === 0 && (
        <div className="card text-center py-12">
          <MailOpen className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}
          </p>
        </div>
      )}

      {!isLoading && !isError && notifications.length > 0 && (
        <ul className="space-y-2" data-testid="notification-list">
          {notifications.map((notification) => (
            <li
              key={notification.id}
              className={`card flex items-start justify-between gap-4 ${
                notification.read ? 'opacity-70' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {!notification.read && (
                    <span
                      aria-label="unread"
                      className="w-2 h-2 rounded-full bg-green-400 shrink-0"
                    />
                  )}
                  <span className="font-medium text-sm">{eventLabel(notification.event)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(notification.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 truncate">
                  Provider {notification.providerId}
                </p>
                <pre className="text-xs text-gray-400 mt-2 whitespace-pre-wrap break-all">
                  {JSON.stringify(notification.payload)}
                </pre>
              </div>

              {!notification.read && (
                <button
                  onClick={() => markRead.mutate(notification.id)}
                  disabled={markRead.isPending}
                  className="text-xs text-green-400 hover:text-green-300 shrink-0 disabled:opacity-50"
                >
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
