/** Human frames stay FIFO while each frame waits for fresh connection authority. */
export function createMemberLifetimeFrameHandler(socket, humanConnection, handleFrame) {
  if (!humanConnection) return handleFrame;
  let pending = Promise.resolve();
  return (raw, isBinary) => {
    pending = pending.then(async () => {
      if (socket.readyState !== 1 || !await humanConnection.authorize() || socket.readyState !== 1) return;
      // No further await between the fresh decision and the synchronous attach/write effect.
      handleFrame(raw, isBinary);
    }).catch(() => { socket.terminate(); });
  };
}
