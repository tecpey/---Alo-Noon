import { useRef, type ReactNode } from 'react'
import { Animated, Pressable, type PressableProps, type ViewStyle } from 'react-native'

/**
 * A control that answers a finger.
 *
 * On the web a button can rely on hover and a cursor to say "this is live". A
 * phone has neither, so the only feedback available is what happens under the
 * thumb — and a control that does nothing at the moment of contact reads as a
 * control that did not register the tap. That is the single most common reason
 * somebody presses a button twice and orders two of something.
 *
 * The scale is small and the return is a spring, matched to the web's own press
 * feedback so the two surfaces feel like one product. `useNativeDriver` keeps
 * the animation off the JavaScript thread, which is what stops it stuttering
 * while a list is still rendering.
 */
export function PressScale({
  children,
  style,
  scaleTo = 0.96,
  ...props
}: PressableProps & {
  children: ReactNode
  style?: ViewStyle | ViewStyle[]
  /** How far it gives. Smaller for big surfaces, or the whole screen wobbles. */
  scaleTo?: number
}) {
  const scale = useRef(new Animated.Value(1)).current

  const to = (value: number) =>
    Animated.spring(scale, {
      toValue: value,
      useNativeDriver: true,
      speed: 40,
      bounciness: 6,
    }).start()

  return (
    <Pressable
      onPressIn={() => to(scaleTo)}
      onPressOut={() => to(1)}
      // Announced as a button unless the caller says otherwise: a Pressable with
      // no role is invisible to a screen reader that is looking for actions.
      accessibilityRole={props.accessibilityRole ?? 'button'}
      {...props}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  )
}
