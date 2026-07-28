import type { CapacitorConfig } from '@capacitor/cli'

/**
 * ATS notes live in docs/ios-app.md. The short version: the app talks cleartext
 * ws:// to a MagicDNS name, which needs an NSExceptionDomains entry for ts.net
 * in ios/App/App/Info.plist. It must never be NSAllowsArbitraryLoads, and the
 * client refuses to pair with a bare IP for exactly that reason.
 */
const config: CapacitorConfig = {
  appId: 'com.holmes.mobile',
  appName: 'Holmes',
  webDir: 'dist',
  ios: {
    contentInset: 'always',
    backgroundColor: '#0d0f12',
  },
  plugins: {
    Keyboard: {
      resize: 'native',
    },
  },
}

export default config
