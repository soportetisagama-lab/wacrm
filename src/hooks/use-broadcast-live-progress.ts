'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { BroadcastSendStats } from '@/hooks/use-broadcast-sending';
import type { BroadcastStatus } from '@/types';
import { liveSendStats, type RecipientCounts } from '@/lib/broadcasts/send-progress';
import { leaseBlocks, readLease } from '@/lib/broadcasts/server-send-logic';

const POLL_MS = 3000;

interface LiveProgress {
  /** Latest stats read from the DB (null before the first reading). */
  stats: BroadcastSendStats | null;
  /** Latest broadcasts.status read (null before the first reading). */
  status: BroadcastStatus | null;
  /**
   * True while a server worker holds a fresh lease on the broadcast.
   * False for a 'sending' broadcast nobody is sending (e.g. one left by
   * the old in-browser send): then "Resume sending" is offered.
   */
  workerAlive: boolean;
}

/**
 * Progress of a broadcast the server is sending, read from the database
 * every 3 s while `enabled`. Works the same whether or not this tab
 * started the send.
 */
export function useBroadcastLiveProgress(
  broadcastId: string,
  enabled: boolean,
  /** Called once when the status read leaves 'sending'. */
  onStopped?: () => void,
): LiveProgress {
  const [live, setLive] = useState<LiveProgress>({ stats: null, status: null, workerAlive: false });
  const first = useRef<{ at: number; done: number } | null>(null);
  const onStoppedRef = useRef(onStopped);
  useEffect(() => {
    onStoppedRef.current = onStopped;
  }, [onStopped]);

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    let cancelled = false;
    let stopped = false;
    first.current = null;

    const count = async (status?: string) => {
      let q = supabase
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId);
      if (status) q = q.eq('status', status);
      const { count: n, error } = await q;
      if (error) throw error;
      return n ?? 0;
    };

    const tick = async () => {
      try {
        const [bc, total, pending, failed] = await Promise.all([
          supabase.from('broadcasts').select('status, audience_filter').eq('id', broadcastId).single(),
          count(),
          count('pending'),
          count('failed'),
        ]);
        if (cancelled || stopped) return;
        const counts: RecipientCounts = { total, pending, failed };
        first.current ??= { at: Date.now(), done: total - pending };
        setLive({
          stats: liveSendStats(counts, first.current),
          status: (bc.data?.status as BroadcastStatus | undefined) ?? null,
          // Any owner but "" — a fresh heartbeat from anyone counts.
          workerAlive: leaseBlocks(readLease(bc.data?.audience_filter), '', Date.now()),
        });
        if (bc.data?.status && bc.data.status !== 'sending') {
          stopped = true;
          clearInterval(timer);
          onStoppedRef.current?.();
        }
      } catch (err) {
        // A missed reading is fine: the next tick tries again.
        console.warn('[broadcasts] progress read failed:', err);
      }
    };

    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [broadcastId, enabled]);

  return live;
}
