# Driving an iOS simulator when host input is blocked

The short version: on a sandboxed Mac you can **screenshot** the simulator but
you often **can't send it taps or keystrokes** from the host. This doc explains
why each obvious path fails and how to work around it with revertable in-app
hacks. Proven on Xcode 26.6 + iOS 26 simulator.

## What's blocked, and why

| Path | Why it fails here |
|------|-------------------|
| **MobAI MCP** | The device bridge was down / unavailable in the session. When it *is* up it's the cleanest option — try `mobai://reference/device-automation` first. |
| **`idb`** (iOS Device Bridge) | Not installed; installing (`brew install facebook/fb/idb-companion` + the python client) isn't reliable in a sandbox and needs its own daemon. |
| **`osascript`** UI scripting / **`cliclick`** | Synthetic mouse/keyboard events require the macOS **Accessibility** permission. Without it they fail with **AppleEvent error `-1719`** ("assistive access not enabled"). Granting it needs a click in System Settings → Privacy & Security → Accessibility — which the sandbox can't perform, so it's a hard wall. |
| **`xcrun simctl openurl <UDID> <customscheme>://…`** | Triggers a system "Open in <App>?" confirmation dialog inside the simulator. It's not clickable from the host and it **sticks** — subsequent screenshots show the stuck dialog until you `xcrun simctl shutdown`/`boot` (reboot) the device. Avoid custom-scheme deep links for automation. |

`xcrun simctl` verbs that **do** work (no special permission): `boot`,
`shutdown`, `launch`, `terminate`, `io … screenshot`, `install`, `list`. These
give you launch + capture — enough to *see*, just not to *touch*.

## The workaround: drive the app from inside, then revert

Since you can't tap, make the app render the post-interaction state on its own,
gated behind `__DEV__` so it can never reach production. Each hack below maps to
a manual action you'd otherwise perform.

### 1. Skip the login screen — auto-login

```tsx
// AuthContext (or wherever you bootstrap auth) — DEV ONLY
useEffect(() => {
  if (__DEV__ && !user) {
    login({ email: "demo@example.com", password: "…" }); // a known dev/demo account
  }
}, [user]);
```

Without this, every screenshot is the login screen. Use a demo/dev account that
has representative data (an empty account shows nothing worth verifying).

### 2. Land on the target screen — force-render it

RN navigators frequently **don't switch tabs reliably** from `initialRouteName`
or an `openurl` deep link. The dependable way to guarantee the screenshot shows
your screen:

```tsx
// The default tab's component — DEV ONLY
export default function HomeTab() {
  if (__DEV__) return <TheScreenIWantToVerify />;
  return <RealHomeTab />;
}
```

### 3. Apply the tap you can't make — force the resulting state

If the thing to verify is "after tapping X, Y highlights", pre-set that state:

```tsx
// DEV ONLY: auto-select what a tap would have selected
const [selectedId, setSelectedId] = useState(__DEV__ ? firstEdge?.id : null);
// DEV ONLY: force a collapsible open
<Section defaultOpen={__DEV__ ? true : false} …/>
```

### 4. Scroll into view — ref + scrollTo after data loads

Setting `contentOffset` at mount is **clamped**, because the content isn't tall
enough yet (data loads async, after first render). Scroll from an effect once the
data is present:

```tsx
const ref = useRef<ScrollView>(null);
useEffect(() => {
  if (__DEV__ && data.length) {
    ref.current?.scrollTo({ y: 600, animated: false });
  }
}, [data]);
```

## Revert discipline (non-negotiable)

These hacks are a **viewing aid**, never part of the change:

1. Remove every `if (__DEV__)` block you added.
2. `git diff` — confirm nothing dev-only remains.
3. Re-run `tsc --noEmit` + lint (in the app dir).
4. *Then* commit the real change and proceed to the build.

A stray `__DEV__` auto-login or force-render that slips into a commit is a real
bug (it changes behaviour in any dev build), so treat the revert as part of the
task, not an afterthought.

## If you genuinely need real taps

When in-app hacks can't reproduce the interaction (e.g. verifying a native
gesture recogniser), fall back to:
- **MobAI MCP** if you can get the bridge up (read its `device-automation`
  reference resource first), or
- a **physical device** via `expo run:ios --device` (a real device you can
  tap), or
- ask the user to grant Accessibility to the terminal/automation tool once, in
  System Settings → Privacy & Security → Accessibility — after which
  `osascript`/`cliclick` synthetic events start working.
