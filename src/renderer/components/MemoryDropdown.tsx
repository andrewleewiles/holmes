import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faServer } from '@fortawesome/free-solid-svg-icons'
import { PillDropdown } from './PillDropdown'
import type { MemoryMode } from '@shared/types'
import disableMemoryIcon from '../../../assets/disableMemory.svg'

interface MemoryDropdownProps {
  value: MemoryMode
  onChange: (mode: MemoryMode) => void
  disabled?: boolean
}

const OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'detailed', label: 'Detailed', hint: 'full context' },
  { value: 'abridged', label: 'Abridged', hint: 'rolling summary' },
  { value: 'anonymous', label: 'Anonymous', hint: 'no memory' },
]

export const MemoryDropdown: FC<MemoryDropdownProps> = ({ value, onChange, disabled }) => {
  const isAnonymous = value === 'anonymous'

  return (
    <PillDropdown
      icon={
        isAnonymous ? (
          <img src={disableMemoryIcon} alt="" className="w-4 h-4" />
        ) : (
          <FontAwesomeIcon icon={faServer} className="w-4 h-4" />
        )
      }
      label="Memory"
      value={value}
      options={OPTIONS}
      onSelect={(v) => onChange(v as MemoryMode)}
      disabled={disabled}
      iconOnly={isAnonymous}
    />
  )
}
