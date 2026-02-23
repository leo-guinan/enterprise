import { useStatus } from '../hooks/useStatus';

export function StatusBar() {
  const { data } = useStatus();
  if (!data) return null;

  const lastBeat = data.lastHeartbeat
    ? `${Math.floor((Date.now() - data.lastHeartbeat) / 1000)}s ago`
    : 'never';

  return (
    <div className="h-7 px-3 flex items-center gap-4 text-xs text-text-muted bg-surface border-t border-border">
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${data.pending > 0 ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'}`} />
        {data.pending > 0 ? `${data.pending} pending` : 'idle'}
      </span>
      <span>daemon: {lastBeat}</span>
    </div>
  );
}
