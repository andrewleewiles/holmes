import { type FC, type CSSProperties } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFolder, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { PROJECT_ICON_REGISTRY } from '../projectIconRegistry'

function isDataUrl(value: string): boolean {
  return value.startsWith('data:')
}

interface ProjectIconProps {
  icon: string
  className?: string
  style?: CSSProperties
}

export const ProjectIcon: FC<ProjectIconProps> = ({ icon, className, style }) => {
  const faIcon: IconDefinition | undefined = PROJECT_ICON_REGISTRY[icon]
  const iconStyle = { color: '#47a08f', ...style }

  if (faIcon) {
    return (
      <FontAwesomeIcon
        icon={faIcon}
        className={className}
        style={iconStyle}
      />
    )
  }

  if (isDataUrl(icon)) {
    return (
      <img
        src={icon}
        alt=""
        className={className}
        style={{ width: '1em', height: '1em', objectFit: 'contain', ...style }}
      />
    )
  }

  return (
    <FontAwesomeIcon
      icon={faFolder}
      className={className}
      style={iconStyle}
    />
  )
}
