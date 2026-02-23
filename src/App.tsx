import { useState } from 'react';
import { ThreadList } from './components/ThreadList';
import { MessageView } from './components/MessageView';
import { MessageInput } from './components/MessageInput';
import { StatusBar } from './components/StatusBar';
import { useMessages, useSendMessage } from './hooks/useMessages';
import { useCreateThread } from './hooks/useThreads';

export default function App() {
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const { data: messages, isLoading } = useMessages(activeThread);
  const sendMessage = useSendMessage(activeThread);
  const createThread = useCreateThread();

  const handleSend = async (content: string) => {
    let threadId = activeThread;

    // Auto-create thread if none selected
    if (!threadId) {
      const thread = await createThread.mutateAsync(content.slice(0, 50));
      threadId = thread.id;
      setActiveThread(threadId);
    }

    sendMessage.mutate(content);
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="flex flex-1 min-h-0">
        <ThreadList activeId={activeThread} onSelect={setActiveThread} />
        <div className="flex-1 flex flex-col">
          <MessageView messages={messages || []} isLoading={isLoading} />
          <MessageInput onSend={handleSend} disabled={sendMessage.isPending} />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
