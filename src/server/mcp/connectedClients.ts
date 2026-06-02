export type ConnectedClientInfo = Readonly<{
  socketId: string;
  userId?: string;
  accountId?: string;
}>;

const connectedClientsBySocketId = new Map<string, ConnectedClientInfo>();

export function upsertConnectedClient(info: ConnectedClientInfo): void {
  if (info.socketId.length === 0) return;
  connectedClientsBySocketId.set(info.socketId, {
    socketId: info.socketId,
    userId: info.userId,
    accountId: info.accountId,
  });
}

export function removeConnectedClient(socketId: string): void {
  if (socketId.length === 0) return;
  connectedClientsBySocketId.delete(socketId);
}

export function listConnectedClients(): ConnectedClientInfo[] {
  return [...connectedClientsBySocketId.values()];
}

export function __resetConnectedClientsForTests(): void {
  connectedClientsBySocketId.clear();
}

