import { Directory, File, Paths } from 'expo-file-system'

import type { OutboxStorage } from './outbox'

/**
 * Where the unsent reports live between launches.
 *
 * A file rather than a key-value store, because the queue is one small ordered
 * document and this app already has `expo-file-system`. It goes in the
 * *document* directory rather than the cache: a cache is something the
 * operating system is entitled to delete when the phone runs low on space, and
 * losing a courier's unsent «delivered» to a housekeeping sweep would be the
 * same defect the queue exists to fix.
 *
 * Every operation is wrapped. Storage failing must never be what a courier sees
 * on a doorstep — `createOutboxStore` already falls back to keeping the queue
 * in memory for the session, which is the part that matters most.
 */
const FILE_NAME = 'courier-outbox.json'

export function createFileOutboxStorage(): OutboxStorage {
  const file = () => new File(new Directory(Paths.document), FILE_NAME)

  return {
    async read() {
      try {
        const handle = file()
        if (!handle.exists) return null
        return handle.textSync()
      } catch {
        return null
      }
    },
    async write(value) {
      const handle = file()
      if (!handle.exists) handle.create({ intermediates: true })
      handle.write(value)
    },
  }
}

/**
 * For the web build and for tests, where there is no document directory.
 *
 * `expo export --platform web` is how this app is previewed, and a courier
 * previewing it should not meet a crash from a native module that is not there.
 * The queue then lives for the session only, which is the correct degradation:
 * everything the outbox does within one run of the app still works.
 */
export function createMemoryOutboxStorage(): OutboxStorage {
  let held: string | null = null
  return {
    read: async () => held,
    write: async (value) => {
      held = value
    },
  }
}
