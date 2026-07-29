import { type CSSProperties, type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { PROJECT_ICON_REGISTRY } from '../projectIconRegistry'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'
import holmesSymbol from '../../../assets/holmesSymbol.svg'

interface AssistantMarkProps {
  className?: string
  style?: CSSProperties
  /**
   * An active character's colour. Applies to a registry icon; a custom image is
   * the user's own artwork and is left alone.
   */
  color?: string
}

/**
 * The assistant's icon wherever the app shows its own face. Mirrors
 * ProjectIcon's contract — a PROJECT_ICON_REGISTRY key or a data: URL — with
 * one extra state: empty means the bundled Holmes symbol, so an untouched
 * install looks exactly as it did before the setting existed.
 */
export const AssistantMark: FC<AssistantMarkProps> = ({ className, style, color }) => {
  const { name, icon } = useAssistantIdentity()

  const faIcon: IconDefinition | undefined = icon ? PROJECT_ICON_REGISTRY[icon] : undefined
  if (faIcon) {
    return <FontAwesomeIcon icon={faIcon} className={className} style={{ color: color ?? '#47a08f', ...style }} />
  }

  const src = icon.startsWith('data:') ? icon : holmesSymbol
  return (
    <img
      src={src}
      alt={name}
      className={className}
      style={{ objectFit: 'contain', ...style }}
    />
  )
}
