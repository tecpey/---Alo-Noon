import type { MetadataRoute } from 'next'

import { colors } from '@alo-noon/design-tokens'

/**
 * What a phone needs before it will let somebody install this.
 *
 * Without a manifest the shop is a website: a customer can bookmark it, and
 * Android will offer them a browser shortcut that opens in a tab with an
 * address bar over it. With one, "الو نون" installs to the home screen and
 * opens as its own thing — which is the difference between a shop somebody
 * visits and a shop somebody has.
 *
 * That matters more here than it would elsewhere. A bread order is a habit: the
 * same person, most mornings, in a hurry. An icon on the home screen is worth
 * more to them than any amount of homepage.
 *
 * Colours come from the token package rather than being written out, so the
 * splash screen a phone paints from this file cannot drift away from the one
 * the app itself renders. A background colour that disagrees with the first
 * paint shows as a flash of the wrong colour on every cold start.
 */
export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    /**
     * The identity a phone keys the installed app on. Fixed as '/' forever: if
     * this changes, every phone that already installed the shop treats the next
     * version as a different application and installs it a second time.
     */
    id: '/',
    name: 'الو نون — نان تازه، درب منزل',
    // What fits under an icon. Anything past about twelve characters is
    // truncated with an ellipsis on Android, and «الو نون» is the name anyway.
    short_name: 'الو نون',
    description:
      'سفارش نان تازه از نانوایی‌های محله؛ پخت‌های ویژه و نان روزمرهٔ بسته‌بندی‌شده، با تحویل در زمانی که خودتان انتخاب می‌کنید.',
    lang: 'fa-IR',
    dir: 'rtl',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // No orientation lock. The Android app is portrait because it was designed
    // for one hand; the site reflows properly and locking a browser to portrait
    // on a tablet is a decision taken away from somebody for no reason.
    background_color: colors.paper,
    theme_color: colors.paper,
    categories: ['food', 'shopping', 'lifestyle'],
    icons: [
      // "any" is the mark as drawn, transparent corners and all — what a
      // browser tab and a task switcher want.
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      /**
       * "maskable" is the one Android actually puts on a home screen, and it is
       * a different picture on purpose: opaque, brand-coloured, with the mark
       * inside the safe zone. Declaring only a transparent icon is how a PWA
       * ends up as a logo floating in a grey circle.
       *
       * Derived from the Android app's own adaptive foreground, cropped to the
       * 66% a launcher shows and composited on the brand orange — so the icon
       * somebody installs from the web and the icon they install from the store
       * are the same icon.
       */
      {
        src: '/brand/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/brand/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    /**
     * Long-press the icon and go straight where you were going.
     *
     * Two, not six. These are the two things a customer opens the app to do
     * that are not "buy bread" — check where an order is, and see what is left
     * on the balance — and a shortcut menu that lists everything is a menu
     * nobody reads.
     */
    shortcuts: [
      {
        name: 'سفارش‌های من',
        short_name: 'سفارش‌ها',
        description: 'وضعیت سفارش‌هایی که در جریان است',
        url: '/orders',
        icons: [{ src: '/brand/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'کیف پول',
        short_name: 'کیف پول',
        description: 'موجودی، شارژ و گردش حساب',
        url: '/wallet',
        icons: [{ src: '/brand/icon-192.png', sizes: '192x192' }],
      },
    ],
  }
}
