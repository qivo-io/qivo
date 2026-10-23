/* A MessageChannel task, which the browser does not clamp the way it
   clamps nested timers, so slices follow each other without idle gaps. */
export function postMessageTask(task: () => void) {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    task()
  }
  channel.port2.postMessage(null)
}
