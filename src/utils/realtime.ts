type RealtimeNotificationPayload = {
  notificationId?: string;
  type?: string;
  title?: string;
  message?: string;
  data?: unknown;
};

export const emitRealtimeNotification = (
  recipientCoupleId: string | null | undefined,
  payload: RealtimeNotificationPayload = {},
): void => {
  if (!recipientCoupleId) return;

  const io = (global as any).io;
  if (!io) return;

  io.to(`couple:${recipientCoupleId}`).emit('notification:new', payload);
};
