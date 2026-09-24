import { describe, expect, it } from 'vitest'

import { courierCopy } from './copy'

describe('courier app copy', () => {
  it('describes delivery work', () => expect(courierCopy.subtitle).toContain('تحویل'))

  it('tells a courier their tap was kept, not that it failed', () => {
    /*
      The sentence a rider reads in a stairwell. It has to say two things and
      neither is optional: their tap was recorded, and it will be sent. The old
      behaviour said only «خطا» and sent people back up a flight of stairs to
      press a button that had, half the time, already worked.
    */
    expect(courierCopy.queuedFa).toContain('ثبت شد')
    expect(courierCopy.queuedFa).toContain('فرستاده می‌شود')
    // Not phrased as a fault: the phone is doing its job.
    expect(courierCopy.queuedFa).not.toContain('خطا')
    expect(courierCopy.queuedFa).not.toContain('ناموفق')
  })

  it('asks for a re-report when something was held too long to send honestly', () => {
    // A «delivered» sent hours late writes the wrong time into the record. The
    // only honest answer is to say so and ask again.
    expect(courierCopy.staleFa).toContain('دوباره')
  })

  it('counts what is waiting in Persian digits', () => {
    expect(courierCopy.waitingFa('۳')).toContain('۳')
    expect(courierCopy.waitingFa('۳')).not.toContain('%s')
  })
})
