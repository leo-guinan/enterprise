import { useThreads, useCreateThread, useDeleteThread } from '../hooks/useThreads';
import type { Thread } from '../lib/api';

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function ThreadList({ activeId, onSelect }: Props) {
  const { data: threads } = useThreads();
  const create = useCreateThread();
  const del = useDeleteThread();

  const handleNew = () => {
    create.mutateAsync().then((t) => onSelect(t.id));
  };

  const timeAgo = (ms: number) => {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div className="w-64 h-full flex flex-col bg-surface border-r border-border">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-sm font-medium text-text-muted">Threads</span>
        <button
          onClick={handleNew}
          className="text-xs px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white transition-colors"
        >
          + New
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {threads?.map((t: Thread) => (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`group px-3 py-2.5 cursor-pointer border-b border-border/50 hover:bg-surface2 transition-colors ${
              activeId === t.id ? 'bg-surface2' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm truncate flex-1">{t.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); del.mutate(t.id); }}
                className="text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs ml-2"
              >
                ×
              </button>
            </div>
            <span className="text-xs text-text-muted">{timeAgo(t.updated_at)}</span>
          </div>
        ))}
        {(!threads || threads.length === 0) && (
          <div className="p-4 text-center text-text-muted text-sm">
            No conversations yet
          </div>
        )}
      </div>
    </div>
  );
}
