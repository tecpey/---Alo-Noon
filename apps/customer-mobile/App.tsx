import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Constants from 'expo-constants'
import * as Location from 'expo-location'
import * as Notifications from 'expo-notifications'
import { StatusBar } from 'expo-status-bar'
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'

import type {
  ActiveCitySummary,
  AddressSummary,
  CartSummary,
  DeliveryWindow,
  OrderSummary,
  PaymentExecutionSummary,
  PaymentSummary,
  DeliveryEstimate,
  PlaceCandidate,
  ProductSummary,
  QuoteSummary,
  SessionContext,
  WalletEntrySummary,
  WalletSummary,
  WalletTransferSummary,
  WalletWithdrawalSummary,
} from '@alo-noon/contracts'
import { colors, ink, line, surface, tint } from '@alo-noon/design-tokens'
import {
  formatDeliveryWindow,
  MINIMUM_WITHDRAWAL,
  orderProgress,
  parseTomanToRial,
  toLatinDigits,
  topUpRefusalMessage,
  transferRefusalMessage,
  validateTopUpAmount,
  validateTransferAmount,
  withdrawalRefusalMessage,
} from '@alo-noon/domain'
import {
  fontFamily,
  GlassSurface,
  hitSlopTo,
  OvenIcon,
  PlusIcon,
  PressScale,
  SteamIcon,
  Text,
  TextInput,
  touchTarget,
} from '@alo-noon/mobile-ui'

import brandMark from './assets/logo-mark.png'
import { createCustomerApiClient, CustomerApiError, type CustomerApiClient } from './src/api'
import { customerCopy } from './src/copy'
import { useAppFonts } from './src/fonts'
import { registerForPushNotifications } from './src/push'
import { AccountScreen } from './src/screens/account'
import { CheckoutChoices } from './src/screens/checkout-choices'
import { OrderDetailScreen, OrdersScreen } from './src/screens/orders'
import { TabBar, type Tab } from './src/screens/tabs'
import { WalletScreen, type WalletTransferStage } from './src/screens/wallet'
import {
  fareLine,
  formatMoney,
  normalizeIranianMobile,
  normalizeOtpCode,
  productPromiseLabel,
  serviceabilityMessage,
} from './src/presentation'

type Screen = 'boot' | 'phone' | 'otp' | 'location' | 'catalog'

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL

/**
 * The EAS project Expo issues push tokens against.
 *
 * Absent in a build that was never made by EAS — a bare `expo start`, or the
 * web export — and absent is handled rather than guessed at: without it there
 * is no token to register, and the app says nothing about it.
 */
const easProjectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined

export default function App() {
  // Before the first hook that could bail out, because hooks may not be
  // conditional: every return below this line happens after the font has been
  // asked for.
  const fontsReady = useAppFonts()
  const api = useMemo(() => {
    if (!apiBaseUrl) return null
    try {
      return createCustomerApiClient(apiBaseUrl)
    } catch {
      return null
    }
  }, [])
  const [screen, setScreen] = useState<Screen>('boot')
  // Which of the three destinations is showing, once the funnel is done. Kept
  // here rather than in a router because there is no history to keep: three
  // flat tabs and one detail below one of them.
  const [tab, setTab] = useState<Tab>('shop')
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [wallet, setWallet] = useState<WalletSummary | null>(null)
  const [walletEntries, setWalletEntries] = useState<WalletEntrySummary[]>([])
  const [walletTransfers, setWalletTransfers] = useState<WalletTransferSummary[]>([])
  const [walletWithdrawals, setWalletWithdrawals] = useState<WalletWithdrawalSummary[]>([])
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletNotice, setWalletNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null,
  )
  const [transferStage, setTransferStage] = useState<WalletTransferStage>({ step: 'idle' })
  const [openOrderId, setOpenOrderId] = useState<string>()
  const [reordering, setReordering] = useState(false)
  const [session, setSession] = useState<SessionContext | null>(null)
  const [cities, setCities] = useState<ActiveCitySummary[]>([])
  const [selectedCityId, setSelectedCityId] = useState<string>()
  const [operationalZoneId, setOperationalZoneId] = useState<string>()
  const [products, setProducts] = useState<ProductSummary[]>([])
  const [cart, setCart] = useState<CartSummary | null>(null)
  const [quote, setQuote] = useState<QuoteSummary | null>(null)
  // What the customer chose before pricing. A quote is priced against both, so
  // changing either throws the quote away rather than leaving a total on screen
  // that belongs to a different set of choices.
  const [windows, setWindows] = useState<DeliveryWindow[]>([])
  const [chosenWindow, setChosenWindow] = useState<string | null>(null)
  const [promotionCode, setPromotionCode] = useState('')
  // Kept so sign-out can hand the same token back. Without it the row stays
  // and the next order buzzes a phone nobody is signed into.
  const [pushToken, setPushToken] = useState<string>()
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [addresses, setAddresses] = useState<AddressSummary[]>([])
  const [selectedAddressId, setSelectedAddressId] = useState<string>()
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number }>()
  /**
   * The way into the shop for somebody who will not hand over a satellite fix.
   *
   * Closed to begin with, because two ways of answering one question on one
   * screen is the shape that makes a customer ask which one they are supposed
   * to use. It opens on request, and opens itself the moment the position
   * prompt is refused.
   */
  const [typedAddressOpen, setTypedAddressOpen] = useState(false)
  /**
   * What delivery costs, for saying so on the shelf rather than after sign-in,
   * an address and a delivery window. Undefined until the shelf opens, and null
   * when no tariff is published — both render as no fare line.
   */
  const [fare, setFare] = useState<DeliveryEstimate | null>()
  const [placeTerm, setPlaceTerm] = useState('')
  /**
   * Undefined is "not searched yet"; an empty array is "searched, and the map
   * provider knows nowhere by that name". The screen must not show those alike
   * — one is a blank space, the other is a reason to try different words.
   */
  const [placeResults, setPlaceResults] = useState<PlaceCandidate[]>()
  /** False means this tenant has no mapping provider at all, so do not offer it. */
  const [placeSearchAvailable, setPlaceSearchAvailable] = useState(true)
  const [addressLabel, setAddressLabel] = useState('خانه')
  const [recipientName, setRecipientName] = useState('')
  const [recipientPhone, setRecipientPhone] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [addressCommandKey, setAddressCommandKey] = useState<string>()
  const [quoteCommandKey, setQuoteCommandKey] = useState<string>()
  const [orderCommandKey, setOrderCommandKey] = useState<string>()
  const [payment, setPayment] = useState<PaymentSummary | null>(null)
  const [execution, setExecution] = useState<PaymentExecutionSummary | null>(null)
  const [paymentCommandKey, setPaymentCommandKey] = useState<string>()
  const [phone, setPhone] = useState('')
  const [otpCommand, setOtpCommand] = useState<{ mobileE164: string; idempotencyKey: string }>()
  const [otp, setOtp] = useState('')
  const [challengeId, setChallengeId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  /**
   * The loaf somebody reached for before they had signed in.
   *
   * Held so the trip through sign-in and location does not lose it. Coming back
   * to an empty basket after being sent away to prove who you are is the moment
   * a customer decides the app wasted their time — and re-finding the bread is
   * the work they already did once.
   */
  const [pendingProduct, setPendingProduct] = useState<ProductSummary>()

  useEffect(() => {
    if (!api) {
      setMessage('نشانی API برنامه تنظیم نشده است.')
      return
    }

    let active = true
    void api
      .getSession()
      .then(async (currentSession) => {
        if (!active) return
        setSession(currentSession)
        if (!currentSession) {
          await browseWithoutSession(api, active)
          return
        }
        setScreen('location')
        // Tokens rotate, so a customer who already agreed has to be
        // re-registered every launch. Silent: `false` means this never puts a
        // permission dialog in front of somebody who has not been asked yet.
        void registerPush(false)
        try {
          await Promise.all([
            loadCities(api, active),
            loadCart(api, active),
            loadAddresses(api, active),
            loadBalance(api, active),
          ])
        } catch (error) {
          if (active) setMessage(errorMessage(error))
        }
      })
      .catch((error: unknown) => {
        if (!active) return
        setMessage(errorMessage(error))
        setScreen('phone')
      })

    async function loadCities(client: CustomerApiClient, stillActive: boolean) {
      const activeCities = await client.listActiveCities()
      if (!stillActive) return
      setCities(activeCities)
      setSelectedCityId(activeCities[0]?.id)
    }

    /**
     * Bread first. Name and street later.
     *
     * This used to open on a phone-number field. A customer who had never seen
     * the shop was asked for their number, then a text message, then their
     * city, then permission to read their location — five gates before a single
     * loaf or a single price appeared, and if they refused the location prompt
     * the screen had nowhere to go.
     *
     * Every part of that is backwards against the evidence. Baymard's cart
     * research puts forced account creation and trust at nineteen per cent of
     * abandonment each, and unexpected cost at thirty-nine: all three are things
     * a shopper can only judge by *looking at the shop*. Asking a stranger to
     * identify themselves before showing them what is for sale inverts the
     * order in which somebody decides to buy bread.
     *
     * The catalogue never needed any of it. `operationalZoneId` is optional on
     * the catalogue query, `listActiveCities` is public, and the web storefront
     * has always shown its shelves to signed-out visitors. The gate was ours,
     * not the API's.
     *
     * So: open on the shelves. Identity is asked for at the first moment it is
     * actually needed — putting a loaf in a basket — where the customer already
     * knows what they are signing in *for*, which is the thing the sign-in
     * screen could never tell them before.
     */
    async function browseWithoutSession(client: CustomerApiClient, stillActive: boolean) {
      try {
        const activeCities = await client.listActiveCities()
        if (!stillActive) return
        setCities(activeCities)
        const city = activeCities[0]
        setSelectedCityId(city?.id)
        if (!city) {
          // No city to shop in is the one case where there is nothing to show.
          setScreen('phone')
          return
        }
        // Without coordinates there is no zone, and the catalogue accepts that:
        // it answers with everything the city sells. Which branch can reach
        // this particular doorstep is a question for checkout, once there is an
        // address to ask it about.
        const catalog = await client.listCatalog({ cityId: city.id })
        if (!stillActive) return
        setProducts(catalog)
        setScreen('catalog')
      } catch (error) {
        if (!stillActive) return
        setMessage(errorMessage(error))
        setScreen('phone')
      }
    }

    async function loadCart(client: CustomerApiClient, stillActive: boolean) {
      const activeCart = await client.getCart()
      if (stillActive) setCart(activeCart)
    }

    async function loadAddresses(client: CustomerApiClient, stillActive: boolean) {
      const saved = await client.listAddresses()
      if (!stillActive) return
      setAddresses(saved)
      setSelectedAddressId(saved[0]?.id)
    }

    /**
     * The balance alone, at sign-in.
     *
     * Checkout needs it to decide whether to offer paying from it, and that
     * decision happens long before anybody opens the wallet tab. Only the
     * balance: the statement is three more rows nobody has asked to see yet.
     */
    async function loadBalance(client: CustomerApiClient, stillActive: boolean) {
      const balance = await client.readWallet()
      if (stillActive) setWallet(balance)
    }

    return () => {
      active = false
    }
  }, [api])

  /**
   * The windows this basket's branch is offering.
   *
   * Read when a basket first has something in it, because the offer belongs to
   * the branch the basket is with — an empty basket has no branch to ask about.
   * Re-read on the branch rather than on every cart version: adding a second
   * loaf does not change what time the ovens run, and refetching on each tap
   * would spend a customer's data to be told the same thing.
   *
   * A failure is silent by design. No windows means the section is not offered
   * and the order goes out as soon as it is ready, which is a complete way to
   * buy bread — putting an error in front of somebody for it would break a
   * checkout that still works.
   */
  const branchWithBasket = cart && cart.items.length > 0 ? cart.bakeryBranchId : null
  useEffect(() => {
    if (!api || !branchWithBasket) {
      setWindows([])
      return
    }

    let active = true
    void api
      .listDeliveryWindows()
      .then((offered) => {
        if (active) setWindows(offered)
      })
      .catch(() => {
        if (active) setWindows([])
      })

    return () => {
      active = false
    }
  }, [api, branchWithBasket])

  /**
   * Tells the server where to reach this customer, if it can.
   *
   * Best-effort and silent by design: every way this fails leaves order
   * messages arriving by SMS, which is what happened before push existed, and
   * none of them is worth an error in front of somebody who came here for
   * bread.
   */
  const registerPush = async (askIfUndetermined: boolean) => {
    if (!api) return
    const outcome = await registerForPushNotifications({
      runtime: Notifications,
      api: {
        register: async (input) => {
          await api.registerPushDevice(input)
          setPushToken(input.expoPushToken)
        },
      },
      projectId: easProjectId,
      platform: Platform.OS,
      askIfUndetermined,
    })
    if (outcome !== 'REGISTERED') setPushToken(undefined)
  }

  const requestOtp = async () => {
    if (!api || busy) return
    const mobileE164 = normalizeIranianMobile(phone)
    if (!mobileE164) {
      setMessage('شماره موبایل معتبر ایران وارد کنید.')
      return
    }

    setBusy(true)
    setMessage(undefined)
    const command =
      otpCommand?.mobileE164 === mobileE164
        ? otpCommand
        : { mobileE164, idempotencyKey: commandKey('otp') }
    setOtpCommand(command)
    try {
      const challenge = await api.requestOtp(mobileE164, command.idempotencyKey)
      setChallengeId(challenge.challengeId)
      setOtp('')
      setOtpCommand(undefined)
      setScreen('otp')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const verifyOtp = async () => {
    if (!api || !challengeId || busy) return
    const normalizedOtp = normalizeOtpCode(otp)
    if (!normalizedOtp) {
      setMessage('کد تأیید باید دقیقاً شش رقم باشد.')
      return
    }

    setBusy(true)
    setMessage(undefined)
    try {
      const currentSession = await api.verifyOtp(challengeId, normalizedOtp)
      setSession(currentSession)
      setChallengeId(undefined)
      setPhone('')
      setOtp('')
      setScreen('location')
      try {
        const activeCities = await api.listActiveCities()
        const [activeCart, savedAddresses] = await Promise.all([api.getCart(), api.listAddresses()])
        setCities(activeCities)
        setSelectedCityId(activeCities[0]?.id)
        setCart(activeCart)
        setAddresses(savedAddresses)
        setSelectedAddressId(savedAddresses[0]?.id)
      } catch (error) {
        setMessage(errorMessage(error))
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshCities = async () => {
    if (!api || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const activeCities = await api.listActiveCities()
      setCities(activeCities)
      setSelectedCityId(activeCities[0]?.id)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * A point on the ground, turned into a shelf.
   *
   * Everything after "where is the doorstep" is the same work whichever way the
   * answer arrived — satellite, a saved address, or a name the customer typed —
   * so it lives here once rather than three times. The three entry points below
   * differ only in how they get the two numbers.
   */
  const enterShopAt = async (cityId: string, latitude: number, longitude: number) => {
    if (!api) return
    const decision = await api.checkServiceability({ cityId, latitude, longitude })
    if (!decision.serviceable || !decision.operationalZoneId) {
      setMessage(serviceabilityMessage(decision.reason))
      return
    }

    const catalog = await api.listCatalog({
      cityId,
      operationalZoneId: decision.operationalZoneId,
    })
    setOperationalZoneId(decision.operationalZoneId)
    setSelectedAddressId(
      addresses.find(
        (address) =>
          address.cityId === cityId && address.operationalZoneId === decision.operationalZoneId,
      )?.id,
    )
    setCoordinates({ latitude, longitude })
    setProducts(catalog)
    setQuote(null)
    setPlaceResults(undefined)
    setPlaceTerm('')
    setScreen('catalog')
    // Neither is awaited. The shelf is the thing the customer asked for; the
    // repeat card and the fare line are offers on top of it, and holding the
    // shop closed until either answers would trade the whole page for a
    // decoration.
    void loadOrders()
    void api
      .deliveryEstimate({ cityId, operationalZoneId: decision.operationalZoneId })
      .then((result) => setFare(result.estimate))
      // A tariff that cannot be read costs a line of text, never the shelf.
      .catch(() => setFare(null))
    // The loaf they reached for before signing in. Added now that there is a
    // session and a zone to add it against, so they arrive at a basket with
    // their bread in it rather than at the shelf they already chose from.
    if (pendingProduct) {
      const resume = pendingProduct
      setPendingProduct(undefined)
      setBusy(false)
      await addProduct(resume, { cityId, operationalZoneId: decision.operationalZoneId })
    }
  }

  const locateAndLoad = async () => {
    if (!api || !selectedCityId || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        /*
          A refusal used to end the path here, and that was the one place in
          this application where it could. Older customers decline this prompt
          often and out of caution, and NN/g measured that a first failure
          roughly doubles the rate at which they abandon — so a dead end here
          costs the order, not a moment.

          The way round opens itself rather than waiting to be found: the
          message names it and the field is already on screen underneath.
        */
        setTypedAddressOpen(true)
        setMessage('اشکالی ندارد — نشانی‌تان را بنویسید تا محدوده را از روی آن بررسی کنیم.')
        return
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      })
      await enterShopAt(selectedCityId, current.coords.latitude, current.coords.longitude)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * The doorstep this customer has already told us about.
   *
   * The cheapest of the three and the one a returning customer should meet
   * first: the coordinates were verified when the address was saved, so there
   * is no prompt, no typing and no map provider in the path at all.
   */
  const enterFromSavedAddress = async (address: AddressSummary) => {
    if (!api || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      setSelectedCityId(address.cityId)
      await enterShopAt(address.cityId, address.latitude, address.longitude)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const searchForPlace = async () => {
    if (!api || busy) return
    const term = placeTerm.trim()
    // Two characters is the shortest thing worth asking a geocoder about, and
    // asking with less is a request that can only come back empty.
    if (term.length < 2) {
      setMessage('برای جست‌وجو دست‌کم دو حرف بنویسید.')
      return
    }
    setBusy(true)
    setMessage(undefined)
    try {
      const found = await api.searchPlaces({
        term,
        ...(selectedCityId && { cityId: selectedCityId }),
      })
      setPlaceSearchAvailable(found.available)
      setPlaceResults([...found.candidates])
      if (!found.available) {
        setMessage('جست‌وجوی نشانی روی این فروشگاه فعال نیست؛ لطفاً موقعیت را روشن کنید.')
      } else if (found.candidates.length === 0) {
        setMessage('جایی با این نام پیدا نشد. نام خیابان یا یک نشانهٔ نزدیک را بنویسید.')
      }
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * @param context Where to add it, for callers that have just worked the
   * answer out and cannot read it back off state yet. `locateAndLoad` is the
   * one: it has set the city and zone moments earlier, and a `useState` setter
   * does not change the value this closure already captured — so without this
   * it would see no zone, bounce the customer back to the location screen, and
   * do it again every time.
   */
  const addProduct = async (
    product: ProductSummary,
    context?: { cityId: string; operationalZoneId: string },
  ) => {
    if (!api || busy) return
    const cityId = context?.cityId ?? selectedCityId
    const zoneId = context?.operationalZoneId ?? operationalZoneId
    /**
     * The first moment identity is genuinely needed, and the first moment it
     * can be explained.
     *
     * Somebody browsing without a session has no `operationalZoneId` — there is
     * no address yet to work out which branch reaches them. Before this, the
     * guard below simply returned, so the add button on a shelf full of bread
     * was a control that looked alive and did nothing at all. A dead button is
     * worse than a locked one: it teaches the customer the app is broken rather
     * than that something is required.
     *
     * Now it carries them into sign-in with the loaf they picked remembered, so
     * the trip through the phone number is visibly *for* something. The basket
     * is filled on the other side by `pendingProduct`.
     */
    if (!session || !cityId || !zoneId) {
      setPendingProduct(product)
      setMessage(undefined)
      setScreen(session ? 'location' : 'phone')
      return
    }
    const currentQuantity =
      cart?.items.find((item) => item.bakeryProductOfferingId === product.offeringId)?.quantity ?? 0
    setBusy(true)
    setMessage(undefined)
    setQuote(null)
    setOrder(null)
    resetPayment()
    try {
      const updated = await api.setCartItem(product.offeringId, {
        cityId,
        operationalZoneId: zoneId,
        quantity: currentQuantity + 1,
        ...(cart && { expectedCartVersion: cart.version }),
      })
      setCart(updated)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const removeCartItem = async (offeringId: string) => {
    if (!api || !cart || busy) return
    setBusy(true)
    setMessage(undefined)
    setQuote(null)
    setOrder(null)
    resetPayment()
    try {
      setCart(await api.removeCartItem(offeringId, cart.version))
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createAddress = async () => {
    if (!api || !selectedCityId || !coordinates || busy) return
    const normalizedPhone = normalizeIranianMobile(recipientPhone)
    if (!normalizedPhone || recipientName.trim().length < 2 || addressLine.trim().length < 10) {
      setMessage('نام گیرنده، شماره موبایل و نشانی کامل را وارد کنید.')
      return
    }
    const idempotencyKey = addressCommandKey ?? commandKey('mobile-address')
    setAddressCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      const created = await api.createAddress({
        cityId: selectedCityId,
        label: addressLabel.trim(),
        recipientName: recipientName.trim(),
        recipientPhone: normalizedPhone,
        addressLine: addressLine.trim(),
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        idempotencyKey,
      })
      setAddresses((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setSelectedAddressId(created.id)
      setAddressCommandKey(undefined)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createQuote = async () => {
    if (!api || !cart || !selectedAddressId || cart.items.length === 0 || busy) return
    const idempotencyKey = quoteCommandKey ?? commandKey('mobile-quote')
    setQuoteCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      const trimmedCode = promotionCode.trim()
      setQuote(
        await api.createQuote(selectedAddressId, cart.version, idempotencyKey, {
          ...(trimmedCode && { promotionCode: trimmedCode }),
          ...(chosenWindow && { deliveryWindowStartsAt: chosenWindow }),
        }),
      )
      setOrder(null)
      resetPayment()
      setQuoteCommandKey(undefined)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createOrder = async () => {
    if (!api || !quote || busy) return
    const idempotencyKey = orderCommandKey ?? commandKey('mobile-order')
    setOrderCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      const placed = await api.createOrder(quote.id, idempotencyKey)
      setOrder(placed)
      setOrderCommandKey(undefined)

      // Now, and not before. An app that asks to send notifications at first
      // launch is asking a stranger for permission to interrupt them; an app
      // that asks the moment there is an order to report on has a reason the
      // customer can see. iOS only ever shows the prompt once.
      void registerPush(true)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const resetPayment = () => {
    setPayment(null)
    setExecution(null)
    setPaymentCommandKey(undefined)
  }

  /**
   * Opens the payment and asks the gateway for a page to send the customer to.
   *
   * Both steps share one idempotency key so a double tap replays onto the same
   * payment and the same attempt rather than opening a second of either. The
   * key is only cleared once a URL is in hand: if the second call fails, the
   * retry must reuse it.
   */
  const startPayment = async (source: 'GATEWAY' | 'BALANCE' = 'GATEWAY') => {
    if (!api || !order || busy) return
    const idempotencyKey = paymentCommandKey ?? commandKey('mobile-payment')
    setPaymentCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)

    // A balance has no bank to wait for: the same call that opens the payment
    // captures it, so there is nothing to initialise and nothing to come back
    // from.
    if (source === 'BALANCE') {
      try {
        setPayment(await api.startPayment(order.id, idempotencyKey, 'BALANCE'))
        setPaymentCommandKey(undefined)
        setOrder(await api.readOrder(order.id))
        void loadWallet()
      } catch (error) {
        setMessage(walletErrorText(error))
        handleAuthenticatedError(error)
      } finally {
        setBusy(false)
      }
      return
    }

    try {
      const opened = payment ?? (await api.startPayment(order.id, idempotencyKey))
      setPayment(opened)
      const result = await api.initializePayment(opened.id, idempotencyKey)
      setExecution(result)
      if (result.customerAction) {
        setPaymentCommandKey(undefined)
        await Linking.openURL(result.customerAction.url)
      } else {
        // No page to send them to means the gateway refused before the customer
        // ever saw it. Its own message is the useful one when there is one.
        setMessage(
          result.failure?.customerMessageKey
            ? customerCopy.paymentRefused
            : customerCopy.paymentUnavailable,
        )
      }
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Asks the API what actually happened, after the customer comes back.
   *
   * Deliberately not driven by the return URL: every parameter on it is
   * attacker-controllable, and the verdict comes from the gateway's own
   * server-to-server answer. Settlement may not have finished when they return,
   * which is why this is a button they can press again rather than a one-shot
   * read.
   */
  const refreshPayment = async () => {
    if (!api || !payment || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      // Both, together: the customer asking "did it go through" and "where is
      // my bread" is the same tap, and the answers live in two aggregates.
      const [freshPayment, freshOrder] = await Promise.all([
        api.readPayment(payment.id),
        order ? api.readOrder(order.id) : Promise.resolve(null),
      ])
      setPayment(freshPayment)
      if (freshOrder) setOrder(freshOrder)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (!api || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      // Before the session goes, while the request can still be authorised.
      if (pushToken) {
        await api.forgetPushDevice(pushToken).catch(() => undefined)
        setPushToken(undefined)
      }
      await api.logout()
      setSession(null)
      setCities([])
      setSelectedCityId(undefined)
      setOperationalZoneId(undefined)
      setProducts([])
      setCart(null)
      setQuote(null)
      setOrder(null)
      resetPayment()
      setAddresses([])
      setSelectedAddressId(undefined)
      setCoordinates(undefined)
      setAddressCommandKey(undefined)
      setQuoteCommandKey(undefined)
      setOrderCommandKey(undefined)
      setChallengeId(undefined)
      // Everything the previous customer could see goes with them. Leaving the
      // order list behind would show one person's orders to the next.
      setOrders([])
      setOpenOrderId(undefined)
      setTab('shop')
      setScreen('phone')
      setMessage(undefined)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Discards the price when a choice that produced it changes.
   *
   * A quote is priced against the window and the code that were sent with it. Leaving the old total on screen after one of them moves
   * shows a number that is no longer the number, and the customer only finds
   * out at the gateway.
   */
  const chooseWindow = (startsAt: string | null) => {
    setChosenWindow(startsAt)
    setQuote(null)
  }
  const changePromotionCode = (code: string) => {
    setPromotionCode(code)
    setQuote(null)
  }

  /**
   * Reads the order list on demand rather than on a timer.
   *
   * A customer opening this tab wants what is true now; a poll would spend
   * their data all morning to say nothing changed.
   */
  const loadOrders = async () => {
    if (!api) return
    setOrdersLoading(true)
    try {
      setOrders(await api.listOrders())
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setOrdersLoading(false)
    }
  }

  /**
   * Everything the wallet screen shows, in one pass.
   *
   * Three reads rather than one, because they are three resources — and all
   * three together, because a balance without its statement is a number a
   * customer cannot check.
   */
  const loadWallet = async () => {
    if (!api) return
    setWalletLoading(true)
    try {
      const [balance, entries, transfers, withdrawals] = await Promise.all([
        api.readWallet(),
        api.listWalletEntries(),
        api.listWalletTransfers(),
        api.listWalletWithdrawals(),
      ])
      setWallet(balance)
      setWalletEntries(entries)
      setWalletTransfers(transfers)
      setWalletWithdrawals(withdrawals)
      // A transfer already waiting for its code is resumed rather than
      // restarted: a customer who closed the app comes back to the code field,
      // not to a form that would charge a second text to reach the same place.
      const pending = transfers.find((transfer) => transfer.state === 'PENDING')
      setTransferStage(pending ? { step: 'confirming', transfer: pending } : { step: 'idle' })
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setWalletLoading(false)
    }
  }

  /**
   * Charges the balance through the bank.
   *
   * The same two calls an order's payment makes, because a top-up is an
   * ordinary payment — which is what buys it the callback route, the settlement
   * sweep and the retry semantics without any of it being written twice.
   */
  const topUpWallet = async (amountToman: string) => {
    if (!api || walletBusy) return
    const amount = parseTomanToRial(amountToman)
    if (amount === null) {
      setWalletNotice({ tone: 'error', text: 'مبلغ شارژ را درست وارد کنید.' })
      return
    }
    const refusal = validateTopUpAmount(amount)
    if (refusal) {
      setWalletNotice({ tone: 'error', text: topUpRefusalMessage(refusal) })
      return
    }

    setWalletBusy(true)
    setWalletNotice(null)
    try {
      const started = await api.startWalletTopUp(amount.toString(), commandKey('mobile-top-up'))
      const result = await api.initializePayment(started.paymentId, commandKey('mobile-top-up-go'))
      if (result.customerAction) {
        await Linking.openURL(result.customerAction.url)
      } else {
        setWalletNotice({ tone: 'error', text: customerCopy.paymentUnavailable })
      }
    } catch (error) {
      setWalletNotice({ tone: 'error', text: walletErrorText(error) })
      handleAuthenticatedError(error)
    } finally {
      setWalletBusy(false)
    }
  }

  /** Names a recipient and an amount, and asks for the code. Moves nothing. */
  const openTransfer = async (input: { recipientMobile: string; amountToman: string }) => {
    if (!api || walletBusy) return
    const recipientMobile = normalizeIranianMobile(input.recipientMobile)
    if (!recipientMobile) {
      setWalletNotice({ tone: 'error', text: 'شمارهٔ گیرنده معتبر نیست.' })
      return
    }
    const amount = parseTomanToRial(input.amountToman)
    if (amount === null) {
      setWalletNotice({ tone: 'error', text: 'مبلغ انتقال را درست وارد کنید.' })
      return
    }
    const refusal = validateTransferAmount(amount)
    if (refusal) {
      setWalletNotice({
        tone: 'error',
        text: transferRefusalMessage(refusal) ?? 'مبلغ انتقال معتبر نیست.',
      })
      return
    }

    setWalletBusy(true)
    setWalletNotice(null)
    try {
      const transfer = await api.openWalletTransfer({
        recipientMobile,
        amountRial: amount.toString(),
        idempotencyKey: commandKey('mobile-transfer'),
      })
      setTransferStage({ step: 'confirming', transfer })
    } catch (error) {
      setWalletNotice({ tone: 'error', text: walletErrorText(error) })
      handleAuthenticatedError(error)
    } finally {
      setWalletBusy(false)
    }
  }

  /**
   * Asks for the balance back, in money.
   *
   * The card number reaches the API once and is never stored on this side: not
   * in state that outlives the call, and not in the idempotency key, which is a
   * value that survives in a database column. The key is the amount and the
   * hour, so a double-tap replays onto the request it already made while a
   * deliberate second withdrawal later in the day gets its own.
   */
  const requestWithdrawal = async (input: {
    amountToman: string
    cardNumber: string
    cardHolderName: string
    iban: string
  }) => {
    if (!api || walletBusy) return
    const amount = parseTomanToRial(input.amountToman)
    if (amount === null) {
      setWalletNotice({ tone: 'error', text: 'مبلغ برداشت را درست وارد کنید.' })
      return
    }
    if (amount < MINIMUM_WITHDRAWAL) {
      setWalletNotice({ tone: 'error', text: withdrawalRefusalMessage('BELOW_MINIMUM') })
      return
    }
    // Digits only, and exactly sixteen. A card pasted from a banking app
    // arrives with spaces or dashes, and a customer should not be told their
    // own card is invalid because of how their bank prints it.
    const cardNumber = toLatinDigits(input.cardNumber).replace(/\D/g, '')
    if (!/^\d{16}$/.test(cardNumber)) {
      setWalletNotice({ tone: 'error', text: 'شمارهٔ کارت باید ۱۶ رقم باشد.' })
      return
    }
    const holder = input.cardHolderName.trim()
    if (holder.length < 2) {
      setWalletNotice({ tone: 'error', text: 'نام صاحب کارت را وارد کنید.' })
      return
    }
    const iban = input.iban ? toLatinDigits(input.iban).replace(/[\s-]/g, '').toUpperCase() : ''
    if (iban && !/^IR\d{24}$/.test(iban)) {
      setWalletNotice({ tone: 'error', text: 'شبا باید با IR و ۲۴ رقم باشد.' })
      return
    }

    setWalletBusy(true)
    setWalletNotice(null)
    try {
      const withdrawal = await api.requestWalletWithdrawal({
        amountRial: amount.toString(),
        cardNumber,
        cardHolderName: holder,
        ...(iban && { iban }),
        idempotencyKey: commandKey('mobile-withdrawal'),
      })
      setWalletNotice({
        tone: 'ok',
        text: `درخواست ثبت شد. ${formatMoney(withdrawal.amount.amount)} از موجودی کم شد و پس از بررسی به کارت شما واریز می‌شود.`,
      })
      await loadWallet()
    } catch (error) {
      setWalletNotice({ tone: 'error', text: walletErrorText(error) })
      handleAuthenticatedError(error)
    } finally {
      setWalletBusy(false)
    }
  }

  /** Types the code back. This is the call that moves the money. */
  const confirmTransfer = async (transferId: string, code: string) => {
    if (!api || walletBusy) return
    const normalized = normalizeOtpCode(code)
    if (!normalized) {
      setWalletNotice({ tone: 'error', text: 'کد تأیید را کامل وارد کنید.' })
      return
    }

    setWalletBusy(true)
    setWalletNotice(null)
    try {
      const transfer = await api.confirmWalletTransfer(transferId, normalized)
      setTransferStage({ step: 'done', transfer })
      setWalletNotice({ tone: 'ok', text: 'انتقال انجام شد.' })
      await loadWallet()
    } catch (error) {
      setWalletNotice({ tone: 'error', text: walletErrorText(error) })
      // A dead transfer must not keep a code field on screen promising a second
      // chance that does not exist.
      if (error instanceof CustomerApiError && error.code !== 'INVALID_CODE') {
        setTransferStage({ step: 'idle' })
        await loadWallet()
      }
      handleAuthenticatedError(error)
    } finally {
      setWalletBusy(false)
    }
  }

  const reorderFrom = async (orderId: string) => {
    if (!api || reordering) return
    setReordering(true)
    setMessage(undefined)
    try {
      const result = await api.reorder(orderId)
      setCart(await api.getCart())
      // The adjustments are the point. Saying nothing and handing somebody two
      // loaves where they asked for four is the failure this exists to avoid.
      setMessage(
        result.adjustments.length === 0
          ? 'سبد از روی همان سفارش پر شد.'
          : result.adjustments
              .map((adjustment) =>
                adjustment.reason === 'REORDER_QUANTITY_REDUCED'
                  ? `${adjustment.nameFa} فقط ${adjustment.quantity.toLocaleString('fa-IR')} عدد موجود بود`
                  : `${adjustment.nameFa} الان موجود نیست`,
              )
              .join(' · '),
      )
      setOpenOrderId(undefined)
      setTab('shop')
    } catch (error) {
      setMessage(errorMessage(error))
      handleAuthenticatedError(error)
    } finally {
      setReordering(false)
    }
  }

  /**
   * The order the shelf offers to repeat.
   *
   * Newest first is what the API returns and what the orders tab already
   * relies on. Derived rather than stored: `orders` is refreshed by the orders
   * tab and by `enterShopAt`, and a second copy of the same fact is a second
   * thing that can be stale.
   */
  const lastOrder = orders[0]
  const fareNote = fareLine(fare)

  const handleAuthenticatedError = (error: unknown) => {
    if (error instanceof CustomerApiError && error.status === 401) {
      setSession(null)
      setCities([])
      setSelectedCityId(undefined)
      setOperationalZoneId(undefined)
      setProducts([])
      setCart(null)
      setQuote(null)
      setOrder(null)
      resetPayment()
      setAddresses([])
      setSelectedAddressId(undefined)
      setCoordinates(undefined)
      setAddressCommandKey(undefined)
      setQuoteCommandKey(undefined)
      setOrderCommandKey(undefined)
      setChallengeId(undefined)
      setScreen('phone')
    }
    setMessage(errorMessage(error))
  }

  // Before anything is painted. The alternative is one frame in Geeza Pro
  // followed by every label on the screen reflowing, which reads as a glitch
  // rather than as loading — and this is the first thing a new customer sees.
  if (!fontsReady) {
    return (
      <Shell>
        <Loading label="در حال آماده‌سازی…" />
      </Shell>
    )
  }

  if (!api) {
    return (
      <Shell>
        <MessageCard title="تنظیمات برنامه کامل نیست" message={message ?? ''} />
      </Shell>
    )
  }

  const openOrder = orders.find((candidate) => candidate.id === openOrderId)
  // What is actually in motion, so the badge means "something is happening"
  // rather than "you have ordered before". A finished order is not news.
  const liveOrderCount = orders.filter((candidate) => {
    const tone = orderProgress(candidate).tone
    return tone === 'live' || tone === 'waiting'
  }).length

  return (
    <Shell
      footer={
        // Only once there is somewhere to go. During the funnel the tabs would
        // lead to two empty screens and one the customer has not reached yet.
        screen === 'catalog' ? (
          <TabBar
            active={tab}
            liveOrderCount={liveOrderCount}
            onChange={(next) => {
              setMessage(undefined)
              setOpenOrderId(undefined)
              setTab(next)
              if (next === 'orders') void loadOrders()
              if (next === 'wallet') void loadWallet()
            }}
          />
        ) : undefined
      }
    >
      {screen === 'boot' && <Loading label="در حال بررسی نشست امن…" />}

      {screen === 'phone' && (
        <AuthCard
          title={customerCopy.phoneTitle}
          hint={customerCopy.phoneHint}
          value={phone}
          placeholder="۰۹۱۱۱۲۳۴۵۶۷"
          keyboardType="phone-pad"
          busy={busy}
          actionLabel="دریافت کد تأیید"
          message={message}
          onChangeText={setPhone}
          onSubmit={requestOtp}
        />
      )}

      {screen === 'otp' && (
        <AuthCard
          title={customerCopy.otpTitle}
          hint="کد شش‌رقمی ارسال‌شده را وارد کنید."
          value={otp}
          placeholder="۱۲۳۴۵۶"
          keyboardType="number-pad"
          maxLength={6}
          busy={busy}
          actionLabel="تأیید و ورود"
          secondaryLabel="اصلاح شماره"
          message={message}
          onChangeText={setOtp}
          onSubmit={verifyOtp}
          onSecondary={() => {
            setChallengeId(undefined)
            setMessage(undefined)
            setScreen('phone')
          }}
        />
      )}

      {screen === 'location' && (
        <View style={styles.card}>
          <Header session={session} onLogout={logout} />
          <Text style={styles.title}>{customerCopy.locationTitle}</Text>
          <Text style={styles.subtitle}>{customerCopy.locationHint}</Text>
          {cities.length === 0 ? (
            <>
              <Text style={styles.emptyText}>{customerCopy.noCities}</Text>
              <PrimaryButton label="تلاش دوباره" busy={busy} onPress={refreshCities} />
            </>
          ) : (
            <>
              <Text style={styles.fieldLabel}>شهر</Text>
              <View style={styles.cityList}>
                {cities.map((city) => (
                  <PressScale
                    key={city.id}
                    scaleTo={0.94}
                    accessibilityState={{ selected: selectedCityId === city.id }}
                    style={[styles.cityChip, selectedCityId === city.id && styles.cityChipSelected]}
                    onPress={() => setSelectedCityId(city.id)}
                  >
                    <Text
                      style={[
                        styles.cityChipText,
                        selectedCityId === city.id && styles.cityChipTextSelected,
                      ]}
                    >
                      {city.nameFa}
                    </Text>
                  </PressScale>
                ))}
              </View>
              {/*
                A doorstep this customer has already given us, offered before
                anything is asked of them. No prompt, no typing, no map
                provider — the coordinates were verified when the address was
                saved. For a returning customer this is the whole screen.
              */}
              {addresses.length > 0 && (
                <>
                  <Text style={styles.fieldLabel}>نشانی‌های شما</Text>
                  <View style={styles.cityList}>
                    {addresses.map((address) => (
                      <PressScale
                        key={address.id}
                        scaleTo={0.94}
                        accessibilityLabel={`تحویل به ${address.label}`}
                        style={styles.cityChip}
                        onPress={() => void enterFromSavedAddress(address)}
                      >
                        <Text style={styles.cityChipText}>{address.label}</Text>
                      </PressScale>
                    ))}
                  </View>
                </>
              )}

              <PrimaryButton
                label="بررسی موقعیت و نمایش محصولات"
                busy={busy}
                disabled={!selectedCityId}
                onPress={locateAndLoad}
              />

              {/*
                The way round the position prompt, and the reason this screen
                is no longer a place the path can end.

                Shut until asked for, so the screen carries one question at a
                time; it opens itself when the prompt is refused. Hidden
                entirely when the tenant has no mapping provider, because a
                search box that cannot search is worse than no search box.
              */}
              {placeSearchAvailable &&
                (typedAddressOpen ? (
                  <>
                    <Text style={styles.fieldLabel}>یا نشانی را بنویسید</Text>
                    <TextInput
                      accessibilityLabel="نشانی یا نام محل"
                      placeholder="مثلاً خیابان مدرس، بابل"
                      placeholderTextColor={colors.neutral[400]}
                      style={styles.input}
                      value={placeTerm}
                      onChangeText={setPlaceTerm}
                      onSubmitEditing={() => void searchForPlace()}
                    />
                    <PrimaryButton
                      label="جست‌وجوی نشانی"
                      busy={busy}
                      disabled={placeTerm.trim().length < 2}
                      onPress={() => void searchForPlace()}
                    />
                    {placeResults?.map((candidate, index) => (
                      <PressScale
                        key={`${candidate.latitude},${candidate.longitude},${index}`}
                        scaleTo={0.97}
                        accessibilityLabel={`${candidate.title}${candidate.address ? `، ${candidate.address}` : ''}`}
                        style={styles.placeRow}
                        onPress={() => {
                          if (!selectedCityId) return
                          void (async () => {
                            setBusy(true)
                            setMessage(undefined)
                            try {
                              await enterShopAt(
                                selectedCityId,
                                candidate.latitude,
                                candidate.longitude,
                              )
                            } catch (error) {
                              handleAuthenticatedError(error)
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }}
                      >
                        <Text style={styles.placeTitle}>{candidate.title}</Text>
                        {candidate.address && (
                          <Text style={styles.placeAddress}>{candidate.address}</Text>
                        )}
                      </PressScale>
                    ))}
                  </>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    style={styles.secondaryButton}
                    onPress={() => setTypedAddressOpen(true)}
                  >
                    <Text style={styles.secondaryButtonText}>
                      نمی‌خواهید موقعیت را روشن کنید؟ نشانی را بنویسید
                    </Text>
                  </Pressable>
                ))}
            </>
          )}
          {message && <InlineMessage text={message} />}
        </View>
      )}

      {screen === 'catalog' && tab === 'orders' && (
        <View style={styles.catalogPanel}>
          {openOrder ? (
            <OrderDetailScreen
              order={openOrder}
              reordering={reordering}
              onBack={() => setOpenOrderId(undefined)}
              onReorder={() => void reorderFrom(openOrder.id)}
            />
          ) : (
            <OrdersScreen
              orders={orders}
              loading={ordersLoading}
              onOpen={(picked) => setOpenOrderId(picked.id)}
              onRefresh={() => void loadOrders()}
            />
          )}
          {message && <InlineMessage text={message} />}
        </View>
      )}

      {screen === 'catalog' && tab === 'wallet' && (
        <View style={styles.catalogPanel}>
          <WalletScreen
            wallet={wallet}
            entries={walletEntries}
            transfers={walletTransfers}
            loading={walletLoading}
            busy={walletBusy}
            notice={walletNotice}
            withdrawals={walletWithdrawals}
            transferStage={transferStage}
            onTopUp={(amount) => void topUpWallet(amount)}
            onOpenTransfer={(input) => void openTransfer(input)}
            onRequestWithdrawal={(input) => void requestWithdrawal(input)}
            onConfirmTransfer={(transferId, code) => void confirmTransfer(transferId, code)}
            onCancelTransfer={() => {
              setTransferStage({ step: 'idle' })
              setWalletNotice(null)
            }}
          />
        </View>
      )}

      {screen === 'catalog' && tab === 'account' && (
        <View style={styles.catalogPanel}>
          <AccountScreen
            session={session}
            addresses={addresses}
            loading={busy}
            selectedAddressId={selectedAddressId}
            onSelect={(addressId) => {
              setSelectedAddressId(addressId)
              // Choosing where it goes is a shopping decision, so it hands the
              // customer back to the basket rather than leaving them on a
              // settings screen wondering whether it took.
              setTab('shop')
            }}
            onAdd={() => setTab('shop')}
            onLogout={() => void logout()}
          />
          {message && <InlineMessage text={message} />}
        </View>
      )}

      {screen === 'catalog' && tab === 'shop' && (
        <View style={styles.catalogPanel}>
          <Header session={session} onLogout={logout} />
          <Text style={styles.title}>{customerCopy.title}</Text>
          <Text style={styles.subtitle}>{customerCopy.subtitle}</Text>

          {/*
            The fare, above everything.

            Extra costs met late are the largest fixable cause of an abandoned
            basket Baymard measures — 39% of shoppers — and this app knew the
            tariff from the moment the shelf loaded while saying nothing until
            three screens later. The wording comes from `fareLine`, which prints
            the same three sentences the website does, so a customer who checks
            on their phone and then on the site meets one promise rather than
            two.
          */}
          {fareNote && (
            <View style={styles.fareNote}>
              <Text style={styles.fareNoteText}>{fareNote.text}</Text>
              {fareNote.note && <Text style={styles.fareNoteQualifier}>{fareNote.note}</Text>}
              {fareNote.freeOver && <Text style={styles.fareNoteFree}>{fareNote.freeOver}</Text>}
            </View>
          )}

          {/*
            Yesterday's basket, above the shelf.

            Reorder already existed, two taps deep in the orders tab, which
            means the customer has to remember it is there. Bread is bought
            again and again — it is the same bread as last week — so the shelf
            is where the offer belongs. Kivetz, Urminsky and Zheng's
            goal-gradient work is the reason it is worth the space: a basket
            that arrives pre-filled moves somebody most of the way to the end
            of the task before they have spent any effort on it.
          */}
          {lastOrder && lastOrder.items.length > 0 && (
            <View style={styles.againCard}>
              <Text style={styles.againTitle}>همان سفارش قبلی</Text>
              <Text style={styles.againItems}>
                {lastOrder.items
                  .map(
                    (item) => `${item.nameFaSnapshot} × ${item.quantity.toLocaleString('fa-IR')}`,
                  )
                  .join('، ')}
              </Text>
              <PrimaryButton
                label="همین را دوباره بفرست"
                busy={reordering}
                onPress={() => void reorderFrom(lastOrder.id)}
              />
            </View>
          )}

          {products.length === 0 ? (
            <Text style={styles.emptyText}>{customerCopy.emptyCatalog}</Text>
          ) : (
            <View style={styles.productList}>
              {products.map((product) => (
                <ProductCard
                  key={product.offeringId}
                  product={product}
                  busy={busy}
                  onAdd={() => void addProduct(product)}
                />
              ))}
            </View>
          )}
          {coordinates && selectedCityId && (
            <AddressCheckoutCard
              addresses={addresses.filter(
                (address) =>
                  address.cityId === selectedCityId &&
                  address.operationalZoneId === operationalZoneId,
              )}
              selectedAddressId={selectedAddressId}
              addressLabel={addressLabel}
              recipientName={recipientName}
              recipientPhone={recipientPhone}
              addressLine={addressLine}
              busy={busy}
              onSelect={setSelectedAddressId}
              onAddressLabel={setAddressLabel}
              onRecipientName={setRecipientName}
              onRecipientPhone={setRecipientPhone}
              onAddressLine={setAddressLine}
              onCreate={() => void createAddress()}
            />
          )}
          {cart && (
            <CartCard
              cart={cart}
              quote={quote}
              order={order}
              payment={payment}
              awaitingReturn={Boolean(execution?.customerAction)}
              addressSelected={Boolean(selectedAddressId)}
              busy={busy}
              onRemove={(offeringId) => void removeCartItem(offeringId)}
              onQuote={() => void createQuote()}
              onOrder={() => void createOrder()}
              onPay={(source) => void startPayment(source)}
              walletBalance={wallet?.balance.amount ?? null}
              onRefreshPayment={() => void refreshPayment()}
              choices={
                <CheckoutChoices
                  windows={windows}
                  chosenWindow={chosenWindow}
                  onChooseWindow={chooseWindow}
                  promotionCode={promotionCode}
                  onPromotionCode={changePromotionCode}
                  quote={quote}
                  now={new Date()}
                />
              }
            />
          )}
          {message && <InlineMessage text={message} />}
          <Pressable
            accessibilityRole="button"
            style={styles.secondaryButton}
            onPress={() => {
              setMessage(undefined)
              setOperationalZoneId(undefined)
              setQuote(null)
              setOrder(null)
              resetPayment()
              setScreen('location')
            }}
          >
            <Text style={styles.secondaryButtonText}>تغییر محدوده</Text>
          </Pressable>
        </View>
      )}
    </Shell>
  )
}

/**
 * The app's frame.
 *
 * The lockup at the top is the real mark beside the real wordmark, the same two
 * things the shopfront and the panel show — a phone app that spells the brand
 * out in the system font is a phone app that belongs to a different company.
 */
function Shell({
  children,
  footer,
}: {
  children: React.ReactNode
  /**
   * Rendered below the scroll view rather than inside it, so the tab bar does
   * not scroll away. Reaching the bottom of a long order list is exactly when
   * somebody wants to leave it.
   */
  footer?: React.ReactNode
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, footer ? styles.scrollContentTabbed : null]}
        keyboardShouldPersistTaps="handled"
      >
        {/*
          Glass, for the same reason the web's bar is: it floats over a screen
          of bread photographs, and a solid bar there cuts the screen in half.
          It is the only glass in this app — a blurred surface is a real GPU
          cost on a phone, so it is spent where it earns its keep.
        */}
        <GlassSurface style={styles.brandBar}>
          <View style={styles.brandLockup}>
            <Text style={styles.brand}>{customerCopy.brandName}</Text>
            <Text style={styles.brandCaption}>{customerCopy.brandTagline}</Text>
          </View>
          <Image
            source={brandMark}
            style={styles.brandMark}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            alt=""
          />
        </GlassSurface>
        {children}
      </ScrollView>
      {footer}
      <StatusBar style="dark" />
    </SafeAreaView>
  )
}

function Header({ session, onLogout }: { session: SessionContext | null; onLogout: () => void }) {
  if (!session) return null
  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionBadge}>
        <Text style={styles.sessionBadgeText}>نشست امن فعال</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onLogout} style={touchTarget.min}>
        <Text style={styles.logoutText}>خروج</Text>
      </Pressable>
    </View>
  )
}

function AuthCard({
  title,
  hint,
  value,
  placeholder,
  keyboardType,
  maxLength,
  busy,
  actionLabel,
  secondaryLabel,
  message,
  onChangeText,
  onSubmit,
  onSecondary,
}: {
  title: string
  hint: string
  value: string
  placeholder: string
  keyboardType: 'phone-pad' | 'number-pad'
  maxLength?: number
  busy: boolean
  actionLabel: string
  secondaryLabel?: string
  message?: string
  onChangeText: (value: string) => void
  onSubmit: () => void
  onSecondary?: () => void
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{hint}</Text>
      <TextInput
        accessibilityLabel={title}
        autoComplete={keyboardType === 'phone-pad' ? 'tel' : 'one-time-code'}
        keyboardType={keyboardType}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={colors.neutral[400]}
        style={styles.input}
        textAlign="left"
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
      />
      <PrimaryButton label={actionLabel} busy={busy} onPress={onSubmit} />
      {secondaryLabel && onSecondary && (
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={onSecondary}>
          <Text style={styles.secondaryButtonText}>{secondaryLabel}</Text>
        </Pressable>
      )}
      {message && <InlineMessage text={message} />}
    </View>
  )
}

function PrimaryButton({
  label,
  busy,
  disabled = false,
  onPress,
  icon,
}: {
  label: string
  busy: boolean
  disabled?: boolean
  onPress: () => void
  /** An optional glyph before the label, for the one or two buttons that earn one. */
  icon?: React.ReactNode
}) {
  return (
    <PressScale
      accessibilityState={{ busy, disabled: busy || disabled }}
      disabled={busy || disabled}
      style={[styles.primaryButton, (busy || disabled) && styles.buttonDisabled]}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color={ink.onAction} />
      ) : (
        <View style={styles.primaryButtonInner}>
          {icon}
          <Text style={styles.primaryButtonText}>{label}</Text>
        </View>
      )}
    </PressScale>
  )
}

function ProductCard({
  product,
  busy,
  onAdd,
}: {
  product: ProductSummary
  busy: boolean
  onAdd: () => void
}) {
  const promise = productPromiseLabel(product)
  const isFresh =
    product.fulfillmentClass === 'SIGNATURE_FRESH' && product.freshnessClaim === 'FRESHLY_PRODUCED'
  return (
    <View style={styles.productCard}>
      <View style={styles.productTopRow}>
        <Text style={styles.productName}>{product.nameFa}</Text>
        <View style={[styles.promiseBadge, isFresh && styles.freshBadge]}>
          {isFresh ? (
            <OvenIcon size={14} color={tint.success.ink} />
          ) : (
            <SteamIcon size={14} color={ink.muted} />
          )}
          <Text style={[styles.promiseText, isFresh && styles.freshText]}>{promise}</Text>
        </View>
      </View>
      <Text style={styles.price}>{formatMoney(product.price.amount)}</Text>
      <PrimaryButton
        label="افزودن به سبد"
        busy={busy}
        onPress={onAdd}
        icon={<PlusIcon size={18} color={ink.onAction} />}
      />
    </View>
  )
}

function AddressCheckoutCard({
  addresses,
  selectedAddressId,
  addressLabel,
  recipientName,
  recipientPhone,
  addressLine,
  busy,
  onSelect,
  onAddressLabel,
  onRecipientName,
  onRecipientPhone,
  onAddressLine,
  onCreate,
}: {
  addresses: AddressSummary[]
  selectedAddressId?: string
  addressLabel: string
  recipientName: string
  recipientPhone: string
  addressLine: string
  busy: boolean
  onSelect: (id: string) => void
  onAddressLabel: (value: string) => void
  onRecipientName: (value: string) => void
  onRecipientPhone: (value: string) => void
  onAddressLine: (value: string) => void
  onCreate: () => void
}) {
  return (
    <View style={styles.cartCard} accessibilityLanguage="fa">
      <Text style={styles.cartTitle}>نشانی تحویل</Text>
      {addresses.map((address) => (
        <Pressable
          key={address.id}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedAddressId === address.id }}
          style={[styles.addressOption, selectedAddressId === address.id && styles.addressSelected]}
          onPress={() => onSelect(address.id)}
        >
          <Text style={styles.cartItemName}>{address.label}</Text>
          <Text style={styles.cartItemMeta}>{address.addressLine}</Text>
        </Pressable>
      ))}
      <Text style={styles.fieldLabel}>افزودن نشانی تازه با موقعیت تأییدشده</Text>
      <TextInput
        accessibilityLabel="عنوان نشانی"
        value={addressLabel}
        onChangeText={onAddressLabel}
        placeholder="خانه"
        style={[styles.input, styles.rtlInput]}
      />
      <TextInput
        accessibilityLabel="نام گیرنده"
        value={recipientName}
        onChangeText={onRecipientName}
        placeholder="نام گیرنده"
        style={[styles.input, styles.rtlInput]}
      />
      <TextInput
        accessibilityLabel="شماره موبایل گیرنده"
        value={recipientPhone}
        onChangeText={onRecipientPhone}
        keyboardType="phone-pad"
        placeholder="۰۹۱۱۱۲۳۴۵۶۷"
        style={styles.input}
        textAlign="left"
      />
      <TextInput
        accessibilityLabel="نشانی کامل"
        value={addressLine}
        onChangeText={onAddressLine}
        placeholder="نشانی کامل برای تحویل"
        multiline
        style={[styles.input, styles.rtlInput]}
      />
      <PrimaryButton label="ذخیره نشانی" busy={busy} onPress={onCreate} />
    </View>
  )
}

function CartCard({
  cart,
  quote,
  order,
  payment,
  awaitingReturn,
  addressSelected,
  busy,
  onRemove,
  onQuote,
  onOrder,
  onPay,
  onRefreshPayment,
  walletBalance,
  choices,
}: {
  cart: CartSummary
  quote: QuoteSummary | null
  order: OrderSummary | null
  payment: PaymentSummary | null
  /** True once the customer has been handed a gateway page to open. */
  awaitingReturn: boolean
  addressSelected: boolean
  busy: boolean
  onRemove: (offeringId: string) => void
  onQuote: () => void
  onOrder: () => void
  onPay: (source: 'GATEWAY' | 'BALANCE') => void
  onRefreshPayment: () => void
  /**
   * The balance, in Rial, or null when it has not been read.
   *
   * Null means the choice is not offered rather than offered and broken. A
   * customer told "pay from balance" and then told the balance is unknown has
   * been asked a question nobody can answer.
   */
  walletBalance: string | null
  /**
   * When, how and with what code — passed in rather than built here so this
   * component keeps knowing only about the basket it was already about.
   */
  choices: ReactNode
}) {
  // Recomputed from the order rather than remembered, so a re-priced basket
  // cannot leave a balance button standing against a total it no longer covers.
  const balanceCovers =
    walletBalance !== null &&
    order !== null &&
    /^\d+$/.test(walletBalance) &&
    /^\d+$/.test(order.total.amount) &&
    BigInt(walletBalance) >= BigInt(order.total.amount)

  return (
    <View style={styles.cartCard}>
      <View style={styles.cartTitleRow}>
        <Text style={styles.cartVersion}>نسخه {cart.version.toLocaleString('fa-IR')}</Text>
        <Text style={styles.cartTitle}>سبد خرید سروری</Text>
      </View>
      {cart.items.length === 0 ? (
        <Text style={styles.emptyText}>سبد خرید خالی است.</Text>
      ) : (
        cart.items.map((item) => (
          <View key={item.id} style={styles.cartItem}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onRemove(item.bakeryProductOfferingId)}
              // Cannot grow: it shares a fixed row with the item's name and
              // price, and a 44-point box here would push that line apart. The
              // touchable area reaches past the word instead.
              hitSlop={hitSlopTo(18)}
            >
              <Text style={styles.removeText}>حذف</Text>
            </Pressable>
            <View style={styles.cartItemCopy}>
              <Text style={styles.cartItemName}>{item.nameFa}</Text>
              <Text style={styles.cartItemMeta}>
                {item.quantity.toLocaleString('fa-IR')} عدد · {formatMoney(item.lineTotal.amount)}
              </Text>
            </View>
          </View>
        ))
      )}
      <View style={styles.totalRow}>
        <Text style={styles.price}>{formatMoney(cart.subtotal.amount)}</Text>
        <Text style={styles.totalLabel}>جمع سبد</Text>
      </View>
      {/* Above the price, because each of these changes it. Hidden once an
          order exists: by then they are decided and the server holds them. */}
      {cart.items.length > 0 && !order && choices}
      <PrimaryButton
        label={quote ? 'محاسبهٔ دوباره' : 'دریافت قیمت نهایی'}
        busy={busy}
        disabled={cart.items.length === 0 || !addressSelected}
        onPress={onQuote}
      />
      {quote && (
        <View style={styles.quoteCard}>
          <Text style={styles.quoteTitle}>قیمت تا زمان درج‌شده معتبر است</Text>
          <Text style={styles.quoteMeta}>
            انقضا: {new Date(quote.expiresAt).toLocaleTimeString('fa-IR')}
          </Text>
          <Text style={styles.quoteMeta}>هزینه ارسال: {formatMoney(quote.deliveryFee.amount)}</Text>
          {/* Only when there is one. A zero discount line invites the question
              "why is my discount nothing". */}
          {quote.discount.amount !== '0' && (
            <Text style={styles.quoteMeta}>تخفیف: {formatMoney(quote.discount.amount)}</Text>
          )}
          {quote.deliveryWindow && (
            <Text style={styles.quoteMeta}>
              زمان تحویل:{' '}
              {formatDeliveryWindow(
                quote.deliveryWindow.startsAt,
                quote.deliveryWindow.endsAt,
                new Date(),
              )}
            </Text>
          )}
          <Text style={styles.quoteTotal}>{formatMoney(quote.total.amount)}</Text>
          <Text style={styles.quoteNotice}>
            مبلغ و نشانی این قیمت در سرور ثبت شده‌اند. پرداخت هنوز آغاز نمی‌شود.
          </Text>
          {!order && <PrimaryButton label="ثبت سفارش" busy={busy} onPress={onOrder} />}
        </View>
      )}
      {order && (
        <View accessibilityLiveRegion="polite" style={styles.orderConfirmation}>
          <Text style={styles.quoteTitle}>سفارش با موفقیت ثبت شد</Text>
          <Text style={styles.quoteMeta}>شماره سفارش: {order.publicId}</Text>
          <Text style={styles.quoteMeta}>پرداخت: {PAYMENT_STATE_FA[payment?.state ?? 'NONE']}</Text>
          <Text style={styles.quoteMeta}>سفارش: {ORDER_STATE_FA[order.state] ?? order.state}</Text>
          {order.productionState !== 'NOT_REQUIRED' && (
            <Text style={styles.quoteMeta}>
              تولید: {PRODUCTION_STATE_FA[order.productionState] ?? order.productionState}
            </Text>
          )}
          <Text style={styles.quoteTotal}>{formatMoney(order.total.amount)}</Text>

          {payment?.state === 'CAPTURED' ? (
            <Text style={styles.quoteNotice}>پرداخت شما تأیید شد.</Text>
          ) : (
            <>
              {awaitingReturn && (
                <Text style={styles.quoteNotice}>{customerCopy.paymentReturn}</Text>
              )}
              {/*
                Two ways money reaches an order, and the balance goes first when
                it covers the total — it is the faster one, and the one that
                does not leave the app. Offered only when it can actually pay:
                a button that refuses is worse than a button that is absent.
              */}
              {balanceCovers && (
                <PrimaryButton
                  label="پرداخت از کیف پول"
                  busy={busy}
                  onPress={() => onPay('BALANCE')}
                />
              )}
              <PrimaryButton
                label={awaitingReturn ? 'پرداخت دوباره' : 'پرداخت با درگاه بانکی'}
                busy={busy}
                onPress={() => onPay('GATEWAY')}
              />
              {walletBalance !== null && !balanceCovers && (
                <Text style={styles.quoteNotice}>
                  موجودی کیف پول ({formatMoney(walletBalance)}) برای این سفارش کافی نیست.
                </Text>
              )}
              {payment && (
                <PrimaryButton label="بررسی وضعیت پرداخت" busy={busy} onPress={onRefreshPayment} />
              )}
            </>
          )}
        </View>
      )}
    </View>
  )
}

/**
 * What a payment state means to the person who just paid.
 *
 * `AUTHORIZED` is not "paid": the gateway has agreed but the money has not been
 * captured, and telling a customer they are done before it has would be a lie
 * the ledger disagrees with.
 */
const PAYMENT_STATE_FA: Readonly<Record<string, string>> = {
  NONE: 'در انتظار پرداخت',
  CREATED: 'در انتظار پرداخت',
  PENDING: 'در حال بررسی با درگاه',
  AUTHORIZED: 'در حال بررسی با درگاه',
  CAPTURED: 'پرداخت‌شده',
  FAILED: 'پرداخت ناموفق',
}

/**
 * The order's own progress, which is the question a customer asks after paying.
 * Kept separate from the payment states above because they answer different
 * things: the money can be in while the bakery has not yet said yes.
 */
const ORDER_STATE_FA: Readonly<Record<string, string>> = {
  DRAFT: 'پیش‌نویس',
  PENDING_CONFIRMATION: 'در انتظار تأیید نانوایی',
  CONFIRMED: 'تأییدشده',
  IN_FULFILLMENT: 'در مسیر تحویل',
  CANCEL_REQUESTED: 'درخواست لغو',
  DELIVERY_FAILED: 'تحویل ناموفق',
  COMPLETED: 'تحویل‌شده',
  CANCELLED: 'لغوشده',
}

const PRODUCTION_STATE_FA: Readonly<Record<string, string>> = {
  UNSCHEDULED: 'در نوبت',
  SCHEDULED: 'زمان‌بندی‌شده',
  IN_PRODUCTION: 'در حال پخت',
  READY: 'آمادهٔ تحویل',
  HANDED_OFF: 'تحویل به پیک',
}

function InlineMessage({ text }: { text: string }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
    </View>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <View style={styles.card}>
      <ActivityIndicator color={colors.primary[700]} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  )
}

function MessageCard({ title, message }: { title: string; message: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <InlineMessage text={message} />
    </View>
  )
}

function commandKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
}

function errorMessage(error: unknown): string {
  if (!(error instanceof CustomerApiError)) {
    return 'ارتباط با سرویس برقرار نشد؛ دوباره تلاش کنید.'
  }

  switch (error.code) {
    case 'OTP_DELIVERY_UNAVAILABLE':
      return 'ارسال پیامک هنوز فعال نشده است؛ کمی بعد دوباره تلاش کنید.'
    case 'OTP_INVALID_OR_EXPIRED':
      return 'کد واردشده نادرست یا منقضی شده است.'
    case 'SESSION_UNAUTHORIZED':
      return 'نشست شما منقضی شده است؛ دوباره وارد شوید.'
    case 'CART_VERSION_CONFLICT':
      return 'سبد خرید تغییر کرده است؛ صفحه را تازه کنید و دوباره تلاش کنید.'
    case 'CART_CONTEXT_MISMATCH':
      return 'محصولات یک سبد باید از یک محدوده و یک شعبه باشند.'
    case 'OFFERING_NOT_FOUND':
    case 'OFFERING_UNAVAILABLE':
      return 'این محصول فعلاً برای سفارش در دسترس نیست.'
    case 'CAPACITY_UNAVAILABLE':
      return 'ظرفیت این شعبه فعلاً تکمیل است.'
    case 'ADDRESS_NOT_SERVICEABLE':
      return 'این نشانی خارج از محدوده تحویل است.'
    case 'ADDRESS_CONTEXT_MISMATCH':
      return 'نشانی انتخابی با محدوده این سبد یکسان نیست.'
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return 'درخواست تکراری با اطلاعات متفاوت دریافت شد؛ دوباره آغاز کنید.'
    case 'QUOTE_EXPIRED':
    case 'QUOTE_NOT_ACTIVE':
      return 'اعتبار قیمت پایان یافته است؛ قیمت تازه دریافت کنید.'
    case 'ORDER_CONCURRENCY_CONFLICT':
      return 'نتیجه ثبت سفارش نامشخص است؛ با همان درخواست دوباره تلاش کنید.'
    case 'CART_EMPTY':
      return 'برای دریافت قیمت، ابتدا محصولی به سبد اضافه کنید.'
    case 'COMMERCE_UNAVAILABLE':
      return 'سبد خرید موقتاً در دسترس نیست؛ دوباره تلاش کنید.'
    case 'CITY_DISCOVERY_UNAVAILABLE':
    case 'SERVICEABILITY_UNAVAILABLE':
    case 'CATALOG_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
      return 'سرویس موقتاً در دسترس نیست؛ دوباره تلاش کنید.'
    case 'INVALID_API_RESPONSE':
      return 'پاسخ سرویس معتبر نبود؛ لطفاً دوباره تلاش کنید.'
    default:
      return 'درخواست انجام نشد؛ اطلاعات را بررسی و دوباره تلاش کنید.'
  }
}

/**
 * Why a wallet request was refused, in words a customer can act on.
 *
 * Separate from `errorMessage` because the API already writes these sentences —
 * the shortfall, the attempts left, the minimum — and rewriting them here would
 * be a second place for the same limit to be quoted, eventually differently.
 * The generic table is the fallback for the transport failures it does cover.
 */
function walletErrorText(error: unknown): string {
  if (!(error instanceof CustomerApiError)) return errorMessage(error)

  const shortfall = walletShortfall(error.details)
  if (shortfall) return `موجودی کافی نیست. ${formatMoney(shortfall)} کم دارید.`

  switch (error.code) {
    case 'INVALID_CODE':
      return `کد تأیید درست نیست.${attemptsSuffix(error.details)}`
    case 'EXHAUSTED':
      return 'این انتقال منقضی شده است. دوباره شروع کنید.'
    case 'NOT_PENDING':
      return 'این انتقال قبلاً بسته شده است.'
    case 'RECIPIENT_NOT_FOUND':
      return 'شماره‌ای که وارد کردید در الو نون ثبت نشده است.'
    case 'SELF_TRANSFER':
      return 'نمی‌توانید به کیف پول خودتان انتقال دهید.'
    case 'CODE_NOT_SENT':
      return 'ارسال کد تأیید ممکن نشد. کمی بعد دوباره تلاش کنید.'
    case 'TOP_UP_UNAVAILABLE':
    case 'WALLET_UNAVAILABLE':
      return 'کیف پول موقتاً در دسترس نیست؛ دوباره تلاش کنید.'
    default:
      return errorMessage(error)
  }
}

/** The Rial figure inside a refusal's `details.shortfall`, when there is one. */
function walletShortfall(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null
  const shortfall = (details as Record<string, unknown>)['shortfall']
  if (!shortfall || typeof shortfall !== 'object') return null
  const amount = (shortfall as { amount?: unknown }).amount
  return typeof amount === 'string' && /^\d+$/.test(amount) ? amount : null
}

/** " ۴ تلاش دیگر باقی است." when the refusal counted, and nothing when it did not. */
function attemptsSuffix(details: unknown): string {
  if (!details || typeof details !== 'object') return ''
  const left = (details as Record<string, unknown>)['attemptsLeft']
  if (typeof left !== 'number' || !Number.isInteger(left) || left < 0) return ''
  return ` ${left.toLocaleString('fa-IR')} تلاش دیگر باقی است.`
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: surface.base },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: 20,
    paddingHorizontal: 20,
    paddingVertical: 32,
  },
  // Centring is right for a single auth card and wrong for a list: an order
  // history that starts halfway down the screen looks like a rendering fault.
  scrollContentTabbed: { justifyContent: 'flex-start' },
  brandBar: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: line.subtle,
  },
  brandLockup: { alignItems: 'flex-end', gap: 2 },
  brandMark: { width: 34, height: 46 },
  brand: {
    color: ink.strong,
    fontSize: 22,
    fontFamily: fontFamily.extraBold,
    textAlign: 'right',
  },
  brandCaption: { color: ink.muted, fontSize: 13, textAlign: 'right' },
  card: {
    gap: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 28,
    backgroundColor: surface.card,
  },
  catalogPanel: { gap: 16 },
  title: {
    color: colors.neutral[900],
    fontSize: 28,
    fontFamily: fontFamily.extraBold,
    lineHeight: 40,
    textAlign: 'right',
  },
  subtitle: {
    color: colors.neutral[600],
    fontSize: 16,
    lineHeight: 28,
    textAlign: 'right',
  },
  fieldLabel: {
    color: colors.neutral[700],
    fontSize: 14,
    fontFamily: fontFamily.bold,
    textAlign: 'right',
  },
  input: {
    minHeight: 56,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: line.base,
    borderRadius: 16,
    backgroundColor: surface.sunken,
    color: ink.strong,
    fontSize: 18,
    writingDirection: 'ltr',
  },
  rtlInput: { textAlign: 'right', writingDirection: 'rtl' },
  primaryButton: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: colors.primary[600],
  },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonInner: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  primaryButtonText: { color: ink.onAction, fontSize: 16, fontFamily: fontFamily.extraBold },
  secondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.primary[200],
    borderRadius: 14,
  },
  secondaryButtonText: { color: ink.action, fontSize: 15, fontFamily: fontFamily.bold },
  message: {
    padding: 14,
    borderWidth: 1,
    borderColor: tint.error.border,
    borderRadius: 14,
    backgroundColor: tint.error.surface,
  },
  messageText: { color: tint.error.ink, lineHeight: 24, textAlign: 'right' },
  loadingText: { color: colors.neutral[700], textAlign: 'center' },
  cityList: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  cityChip: {
    ...touchTarget.min,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.neutral[300],
    borderRadius: 999,
    backgroundColor: colors.neutral[50],
  },
  /*
    A search result, sized as a row rather than a chip: it carries two lines —
    the name of the place and the street it is on — and a customer choosing
    between two junctions with similar names needs the second line to tell
    them apart.
  */
  /*
    The repeat-order card above the shelf. Sunken paper with a dashed edge, so
    it reads as the shop remembering something rather than as one more product
    to choose between.
  */
  /*
    The fare line. Quiet: it is a fact the customer needs in order to decide,
    not an offer competing with the bread. The free-delivery line is the one
    exception, because that one *is* an offer.
  */
  fareNote: {
    gap: 3,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.neutral[200],
    borderRadius: 14,
    backgroundColor: colors.neutral[50],
  },
  fareNoteText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: ink.strong,
    textAlign: 'right',
  },
  fareNoteQualifier: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    lineHeight: 24,
    color: ink.muted,
    textAlign: 'right',
  },
  fareNoteFree: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    color: ink.action,
    textAlign: 'right',
  },
  againCard: {
    gap: 8,
    padding: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.neutral[300],
    borderRadius: 16,
    backgroundColor: colors.neutral[50],
  },
  againTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: ink.strong,
    textAlign: 'right',
  },
  againItems: {
    fontFamily: fontFamily.regular,
    fontSize: 14,
    lineHeight: 26,
    color: ink.base,
    textAlign: 'right',
  },
  placeRow: {
    ...touchTarget.comfortable,
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.neutral[300],
    borderRadius: 14,
    backgroundColor: colors.neutral[50],
  },
  placeTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: ink.strong,
    textAlign: 'right',
  },
  placeAddress: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: ink.muted,
    textAlign: 'right',
  },
  cityChipSelected: {
    borderColor: colors.primary[700],
    backgroundColor: colors.primary[100],
  },
  cityChipText: { color: colors.neutral[700], fontFamily: fontFamily.bold },
  cityChipTextSelected: { color: colors.primary[900] },
  sessionRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sessionBadge: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: tint.success.surface,
  },
  sessionBadgeText: { color: tint.success.ink, fontSize: 12, fontFamily: fontFamily.extraBold },
  logoutText: { color: ink.action, fontFamily: fontFamily.bold },
  emptyText: {
    padding: 18,
    borderRadius: 16,
    backgroundColor: colors.neutral[100],
    color: colors.neutral[600],
    lineHeight: 26,
    textAlign: 'right',
  },
  productList: { gap: 12 },
  productCard: {
    gap: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 20,
    backgroundColor: surface.card,
  },
  productTopRow: { gap: 12 },
  productName: {
    color: colors.neutral[900],
    fontSize: 19,
    fontFamily: fontFamily.extraBold,
    textAlign: 'right',
  },
  promiseBadge: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.neutral[100],
  },
  promiseText: { color: colors.neutral[700], fontSize: 12, fontFamily: fontFamily.bold },
  freshBadge: { backgroundColor: tint.success.surface },
  freshText: { color: tint.success.ink },
  price: { color: ink.action, fontSize: 16, fontFamily: fontFamily.extraBold, textAlign: 'right' },
  cartCard: {
    gap: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.primary[200],
    borderRadius: 22,
    backgroundColor: colors.cream,
  },
  cartTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cartTitle: { color: colors.neutral[900], fontSize: 20, fontFamily: fontFamily.extraBold },
  cartVersion: { color: colors.neutral[500], fontSize: 12 },
  cartItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary[100],
  },
  cartItemCopy: { flex: 1, gap: 4, alignItems: 'flex-end' },
  cartItemName: {
    color: colors.neutral[900],
    fontFamily: fontFamily.extraBold,
    textAlign: 'right',
  },
  cartItemMeta: { color: colors.neutral[600], fontSize: 13, textAlign: 'right' },
  removeText: { color: colors.error, fontSize: 13, fontFamily: fontFamily.bold },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: { color: colors.neutral[700], fontFamily: fontFamily.extraBold },
  quoteCard: {
    gap: 8,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.neutral[50],
  },
  quoteTitle: { color: colors.success, fontFamily: fontFamily.extraBold, textAlign: 'right' },
  quoteMeta: { color: colors.neutral[600], textAlign: 'right' },
  quoteTotal: {
    color: ink.action,
    fontSize: 22,
    fontFamily: fontFamily.extraBold,
    textAlign: 'right',
  },
  quoteNotice: { color: colors.neutral[600], fontSize: 12, lineHeight: 20, textAlign: 'right' },
  addressOption: {
    gap: 4,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.neutral[200],
    borderRadius: 14,
    backgroundColor: colors.neutral[50],
  },
  addressSelected: { borderColor: colors.primary[700], backgroundColor: colors.primary[100] },
  orderConfirmation: {
    gap: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: tint.success.border,
    borderRadius: 16,
    backgroundColor: tint.success.surface,
  },
})
