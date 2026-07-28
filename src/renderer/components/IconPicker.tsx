import { type FC, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { PROJECT_ICON_REGISTRY } from '../projectIconRegistry'
import { ProjectIcon } from './ProjectIcon'

interface IconPickerProps {
  value: string
  onChange: (icon: string) => void
  onSelectImage: () => Promise<string | null>
}

const SUGGESTED_KEYS = [
  'folder', 'folder-open', 'box', 'box-open', 'briefcase', 'rocket',
  'lightbulb', 'star', 'heart', 'gear', 'code', 'book', 'book-open',
  'globe', 'compass', 'map', 'flag', 'trophy', 'bullseye', 'crown',
]

const CATEGORY_GROUPS: Array<{ label: string; keywords: string[] }> = [
  {
    label: 'Work',
    keywords: ['briefcase','suitcase','bag','cart','store','warehouse','industry','building','office','landmark','school','university','hotel','hospital','bank','shop','gear','gears','cog','wrench','hammer','screwdriver','tools','toolbox','code','laptop','computer','desktop','server','database','network','microchip','plug','keyboard','mouse','print','calculator','receipt','chart','percent','vault','cash-register','stamp','trademark','bitcoin','credit','wallet','money','coins','dollar','piggy','clipboard','archive','file','folder','copy','paste','scissors','pen','pencil','signature','envelope','paperclip','paper-plane','link','phone','mobile','bluetooth','wifi','signal','satellite','radio','tower','router','qrcode','barcode','fingerprint','key','lock','unlock','shield','magnifying-glass','microscope','flask','vial','atom','bug','terminal','cube','cubes','shapes','square'],
  },
  {
    label: 'Tech',
    keywords: ['code','laptop','computer','desktop','server','database','network','microchip','memory','plug','keyboard','mouse','print','camera','video','film','clapperboard','headphones','headset','microphone','microscope','flask','vial','atom','magnifying-glass','bug','terminal','cube','cubes','shapes','square','qrcode','barcode','fingerprint','robot','satellite','satellite-dish','radio','tower','signal','wifi','router','mobile','phone','bluetooth','battery','plug-circle','screwdriver-wrench','wrench','tools','fingerprint','microchip','memory'],
  },
  {
    label: 'People',
    keywords: ['user','users','people','person','baby','child','user-tie','user-ninja','user-secret','user-astronaut','user-graduate','user-shield','user-doctor','user-nurse','user-check','user-gear','user-pen','user-plus','user-minus','user-xmark','user-clock','people-group','people-line','user-friends','user-group','person-dress','person-praying','person-pregnant','hand','hand-fist','hands','hands-praying','handshake','hand-holding','hand-back-fist','thumbs-up','thumbs-down','ear','ear-listen','eye','tooth','teeth','bone','brain','heart','heart-pulse','face','smile','child','baby','person-walking','person-running','person-swimming','person-biking'],
  },
  {
    label: 'Nature',
    keywords: ['tree','leaf','seedling','clover','plant','spa','sun','moon','cloud','rainbow','snowflake','bolt','fire','water','mountain','volcano','wind','globe','earth','map','location','compass','route','tent','campground','umbrella','feather','flood','tornado','smog','mountain-sun','cat','dog','cow','horse','frog','fish','crow','dove','owl','kiwi-bird','spider','hippo','worm','shrimp','paw','bug','horse-head','otter','penguin','apple','lemon','egg','cheese','bread','croissant','cupcake','cookie','ice-cream','bowl','mug','wine','beer','glass','utensils','pizza','drumstick','bottle','carrot','corn','wheat','burger','hotdog','sandwich','pepper','jar'],
  },
  {
    label: 'Travel',
    keywords: ['plane','helicopter','rocket','ship','ferry','sailboat','anchor','truck','tractor','motorcycle','bicycle','car','bus','train','tram','subway','taxi','ambulance','van-shuttle','traffic-light','road','sign','tower','satellite','gas-pump','charging-station','map','location','compass','compass-drafting','tent','campground','caravan','flag','flag-checkered','passport','ticket','suitcase','luggage','concierge-bell','umbrella-beach','kite','bridge','mountain-sun','plane-up','plane-departure','plane-arrival','truck-fast','car-side','bus-simple','train-subway','tower-observation','tower-cell','tower-broadcast','map-location','location-crosshairs'],
  },
  {
    label: 'Health',
    keywords: ['heart','heart-pulse','heart-crack','brain','tooth','teeth','bone','eye','ear','ear-listen','hand','hand-fist','kit-medical','stethoscope','hospital','syringe','vial','flask','microscope','prescription','bandage','capsules','pills','thermometer','temperature','weight-scale','scale-balanced','dumbbell','person-swimming','person-running','person-biking','spa','bath','shower','soap','water-ladder','hot-tub','sauna','helmet-safety','shoe-prints','stopwatch','trophy','medal','award','futbol','soccer','football','basketball','baseball','volleyball','hockey','gamepad'],
  },
  {
    label: 'Symbols',
    keywords: ['star','flag','crown','fire','burst','bomb','ghost','skull','mask','wand-magic','hamsa','khanda','yin-yang','torii-gate','vihara','cross','dharmachakra','dove','feather','clover','rainbow','sun','moon','snowflake','circle','question','plus','minus','xmark','ban','check','triangle-exclamation','bookmark','lightbulb','bell','bullhorn','comment','envelope','paper-plane','paperclip','link','signature','quote','asterisk','certificate','gem','diamond','hat-wizard','hat-cowboy','telescope','hourglass','clock','alarm-clock','calendar','note-sticky','book','book-open','library','newspaper','scroll','gift','cake','music','guitar','drum','piano','compact-disc','record-vinyl','tape','microphone','masks-theater','paintbrush','palette','brush'],
  },
]

function categorizeIconKeys(): Array<{ label: string; keys: string[] }> {
  const all = Object.keys(PROJECT_ICON_REGISTRY).sort()
  return CATEGORY_GROUPS.map((group) => ({
    label: group.label,
    keys: all.filter((key) => group.keywords.some((kw) => key.includes(kw))),
  })).filter((group) => group.keys.length > 0)
}

type Mode = 'icons' | 'image'

export const IconPicker: FC<IconPickerProps> = ({ value, onChange, onSelectImage }) => {
  const [mode, setMode] = useState<Mode>('icons')
  const categories = useMemo(categorizeIconKeys, [])
  const [activeCategory, setActiveCategory] = useState(0)
  const [query, setQuery] = useState('')
  const [imageError, setImageError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleImagePick = async () => {
    setImageError(null)
    setUploading(true)
    try {
      const dataUrl = await onSelectImage()
      if (dataUrl) {
        onChange(dataUrl)
      }
    } catch (err) {
      setImageError(err instanceof Error ? err.message : 'Could not load image')
    } finally {
      setUploading(false)
    }
  }

  const searchResults = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return null
    return Object.keys(PROJECT_ICON_REGISTRY)
      .filter((key) => key.replace(/-/g, ' ').includes(trimmed))
      .slice(0, 60)
  }, [query])

  const activeKeys = searchResults ?? categories[activeCategory]?.keys ?? []

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-black/20">
          <ProjectIcon icon={value} className="text-2xl" />
        </div>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode('icons')}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
              mode === 'icons' ? 'bg-holmes-primary/15 text-holmes-primary-light' : 'text-white/50 hover:text-white/80'
            }`}
          >
            Icons
          </button>
          <button
            type="button"
            onClick={() => setMode('image')}
            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
              mode === 'image' ? 'bg-holmes-primary/15 text-holmes-primary-light' : 'text-white/50 hover:text-white/80'
            }`}
          >
            Custom image
          </button>
        </div>
      </div>

      {mode === 'icons' ? (
        <>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {SUGGESTED_KEYS.map((key) => {
              const definition: IconDefinition | undefined = PROJECT_ICON_REGISTRY[key]
              if (!definition) return null
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChange(key)}
                  className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors cursor-pointer ${
                    value === key ? 'border-holmes-primary bg-holmes-primary/10' : 'border-white/10 hover:border-white/25'
                  }`}
                  title={key}
                >
                  <FontAwesomeIcon icon={definition} className="text-sm" style={{ color: '#47a08f' }} />
                </button>
              )
            })}
          </div>

          <div className="relative mb-2">
            <FontAwesomeIcon
              icon={PROJECT_ICON_REGISTRY['magnifying-glass']}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-white/30"
              style={{ color: '#9b948f' }}
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search icons..."
              className="w-full rounded-md border border-white/15 bg-transparent pl-7 pr-2 py-1.5 text-xs text-white outline-none focus:border-holmes-primary"
            />
          </div>

          {!searchResults && (
            <div className="flex flex-wrap gap-1 mb-2">
              {categories.map((category, index) => (
                <button
                  key={category.label}
                  type="button"
                  onClick={() => setActiveCategory(index)}
                  className={`text-[11px] px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    activeCategory === index ? 'bg-white/10 text-white/80' : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  {category.label}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-8 gap-1 max-h-44 overflow-y-auto scrollbar-thin rounded-md border border-white/5 p-2 bg-black/10">
            {activeKeys.map((key) => {
              const definition: IconDefinition | undefined = PROJECT_ICON_REGISTRY[key]
              if (!definition) return null
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChange(key)}
                  className={`flex h-8 w-8 items-center justify-center rounded text-base leading-none transition-colors cursor-pointer ${
                    value === key ? 'bg-holmes-primary/20 ring-1 ring-holmes-primary' : 'hover:bg-white/10'
                  }`}
                  title={key}
                >
                  <FontAwesomeIcon icon={definition} style={{ color: '#47a08f' }} />
                </button>
              )
            })}
            {activeKeys.length === 0 && (
              <p className="col-span-8 py-4 text-center text-xs text-white/30">No matching icons</p>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-white/40">
            Upload an image to use as the project icon. PNG, JPG, GIF, or SVG up to 1 MB.
          </p>
          <button
            type="button"
            onClick={handleImagePick}
            disabled={uploading}
            className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            {uploading ? 'Loading...' : 'Upload image'}
          </button>
          {value.startsWith('data:') && (
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-black/20">
                <ProjectIcon icon={value} className="text-base" />
              </div>
              <button
                type="button"
                onClick={() => onChange('folder')}
                className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
              >
                Remove image
              </button>
            </div>
          )}
          {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
        </div>
      )}
    </div>
  )
}
