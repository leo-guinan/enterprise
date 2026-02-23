import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useMessages(threadId: string | null) {
  return useQuery({
    queryKey: ['messages', threadId],
    queryFn: () => api.listMessages(threadId!),
    enabled: !!threadId,
    refetchInterval: 500,
  });
}

export function useSendMessage(threadId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.sendMessage(threadId!, content),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages', threadId] });
      qc.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}
