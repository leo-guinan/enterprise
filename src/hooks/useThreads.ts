import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useThreads() {
  return useQuery({
    queryKey: ['threads'],
    queryFn: api.listThreads,
    refetchInterval: 5000,
  });
}

export function useCreateThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => api.createThread(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['threads'] }),
  });
}

export function useDeleteThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteThread(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['threads'] }),
  });
}
