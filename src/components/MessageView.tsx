import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import type { Message } from '../lib/api';

interface Props {
  messages: Message[];
  isLoading: boolean;
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  const isPending = msg.status === 'pending' || msg.status === 'processing';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
          isUser
            ? 'bg-accent text-white rounded-br-md'
            : 'bg-surface2 text-text rounded-bl-md'
        } ${isPending ? 'opacity-60' : ''}`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <Markdown>{msg.content}</Markdown>
          </div>
        )}
        {isPending && (
          <div className="mt-1 text-xs opacity-60">
            {msg.status === 'processing' ? 'Processing...' : 'Queued'}
          </div>
        )}
      </div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex justify-start mb-4">
      <div className="bg-surface2 px-4 py-3 rounded-2xl rounded-bl-md">
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

export function MessageView({ messages, isLoading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasPending = messages.some((m) => m.status === 'pending' || m.status === 'processing');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, hasPending]);

  if (!messages.length && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <div className="text-center">
          <div className="text-4xl mb-3">🚀</div>
          <div className="text-lg font-medium">The Enterprise</div>
          <div className="text-sm mt-1">Type a message to begin</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}
      {hasPending && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
