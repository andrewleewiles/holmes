import { getRole } from '@shared/roles'
import { DEFAULT_WELCOME_LINES } from './welcomeLines'

/**
 * A role played by a character. The role decides how the assistant behaves;
 * the character is the face it wears while doing it — its name, its colour, and
 * the greetings it opens with.
 *
 * Transcribed from assets/characterRoles.xlsx. `role` matches RoleDefinition.name
 * rather than a role id, so a character is waiting for every role in the sheet —
 * including the ones the app has not grown yet. Tools are deliberately not
 * modelled here.
 */
export interface Character {
  id: string
  name: string
  /** RoleDefinition.name, or GENERAL_ROLE for "no role selected". */
  role: string
  /** Hex, as authored in the sheet. Paints the mark and the name above the greeting. */
  color: string
  lines: string[]
}

/** What the assistant is when no role is selected. */
export const GENERAL_ROLE = 'General'

/**
 * Holmes is the app's own face, so his greetings stay in welcomeText.txt: that
 * file is also the default the Settings greeting editor resets to, and the two
 * must not drift apart. Every other character carries its lines here.
 */
const HOLMES: Character = {
  id: 'holmes',
  name: 'Holmes',
  role: GENERAL_ROLE,
  color: '#47a08f',
  lines: DEFAULT_WELCOME_LINES,
}

export const CHARACTERS: readonly Character[] = [
  HOLMES,
  {
    id: 'seward',
    name: 'Seward',
    role: 'Therapist',
    color: '#8861b5',
    lines: [
      'Cannot eat, cannot rest, so diary instead.',
      'How many of us begin a new record with each day of our lives?',
      'I have closed the account most accurately, and to-day begun a new record.',
      'Truly there is no such thing as finality.',
      'Only resolution and habit can let me make an entry to-night.',
      'As I knew that the only cure for this sort of thing was work, I went down amongst the patients.',
      'Let me get on with my work.',
      'It is wonderful what a good night\'s sleep will do for one.',
      'To-day I seemed to get nearer than ever before to the heart of your mystery.',
      'I shall have to invent a new classification for you.',
      'I wish I could get some clue to the cause.',
      'Why not advance science in its most difficult and vital aspect — the knowledge of the brain?',
    ],
  },
  {
    id: 'geppetto',
    name: 'Geppetto',
    role: '3D Modeler',
    color: '#bc9357',
    lines: [
      'I just made a puppet. But the magic… that was someone else.',
      'The hands that carve must first believe the wood already knows its shape.',
      'Patience is not waiting, [user]. It is working while you wait and calling the work the same thing.',
      'There is no such thing as an inanimate object, [user]. There are only things no one has spoken to yet.',
      'Paint is no cure for a bad cut.',
      'You cannot give a thing a conscience. But you can give it someone who worries about it, and that is close enough.',
      'It is not finished when it looks alive. It is finished when it moves.',
      'Give a shape enough care and it will begin to move on its own.',
    ],
  },
  {
    id: 'basil',
    name: 'Basil',
    role: 'Designer',
    color: '#6856e8',
    lines: [
      'It is not he who is revealed by the painter; it is rather the painter who, on the coloured canvas, reveals himself.',
      'It is the best thing I have ever done.',
      'I am afraid that I have shown in it the secret of my own soul.',
      'There is nothing that art cannot express.',
      'There is too much of myself in the thing — too much of myself!',
    ],
  },
  {
    id: 'gradgrind',
    name: 'Gradgrind',
    role: 'Data Analyst',
    color: '#5c6b5e',
    lines: [
      'Now, what I want is, Facts.',
      'Facts alone are wanted in life.',
      'Thomas Gradgrind, sir. A man of realities. A man of facts and calculations.',
      'You can only form the minds of reasoning animals upon Facts: nothing else will ever be of any service to them.',
      'Stick to Facts, sir!',
      'I ask you, [user first name], have you a heart?',
      'It is a mere question of figures, a case of simple arithmetic.',
      'Fact, fact, fact!',
      'I need not point out to you, [user first name], that it is governed by the laws which govern lives in the aggregate.',
      'It is quite right, my dear, to be exact.',
    ],
  },
  {
    id: 'cavor',
    name: 'Cavor',
    role: 'Programmer',
    color: '#6ca7b7',
    lines: [
      'This shows you how useless knowledge is unless you apply it.',
      'My mind was preoccupied with another problem, and I\'m apt to disregard these practical side issues.',
      'One cannot foresee everything, you know.',
      'Of course we must make it again.',
      'Nothing clears up one\'s ideas so much as explaining them.',
      'It\'s extraordinary how one gets new points of view by talking over things!',
      'My mind is much occupied.',
      'Look here, [user], you came on this expedition of your own free will.',
      'It\'s perfectly simple',
      'It may be one of those things that are a theoretical possibility, but a practical absurdity. Or when we make it, there may be some little hitch!',
    ],
  },
  {
    id: 'oz',
    name: 'Oz',
    role: 'Game Studio',
    color: '#63a800',
    lines: [
      'I have been making believe.',
      'I\'m supposed to be a Great Wizard.',
      'I am a humbug.',
      'I have played Wizard for so many years that I may as well continue the part a little longer.',
      'Experience is the only thing that brings knowledge.',
      'I will stuff your head with brains. I cannot tell you how to use them, however; you must find that out for yourself.',
      'I don\'t care who kills her.',
      'Come to me tomorrow, for I must have time to think it over.',
      'My people have worn green glasses on their eyes so long that most of them think it really is an Emerald City.',
      'You have plenty of courage, I am sure. All you need is confidence in yourself.',
      'I stood behind the screen and pulled a thread, to make the eyes move and the mouth open.',
    ],
  },
  {
    id: 'cyrano',
    name: 'Cyrano',
    role: 'Writer',
    color: '#a36774',
    lines: [
      'You might have said at least a hundred things by varying the tone.',
      'Such, my dear [user], is what you might have said, had you of wit or letters the least jot.',
      'Wait while I choose my rhymes—I have them now!',
      'Take it, and change feigned love-words into true.',
      'Eloquent all the more, the less sincere!',
      'Wed into one my phrases and your lips.',
      'It is an enterprise to tempt a poet.',
      'Eloquence! Where to find it?',
    ],
  },
]

/**
 * The character for a role id. Falls back to Holmes for no role, an unknown
 * role, or a role no character has been written for yet.
 */
export function getCharacter(roleId: string | null | undefined): Character {
  const roleName = getRole(roleId)?.name
  if (!roleName) return HOLMES
  return CHARACTERS.find((character) => character.role === roleName) ?? HOLMES
}

/** Holmes is the app itself, so he answers to the user's chosen assistant name. */
export function isDefaultCharacter(character: Character): boolean {
  return character.id === HOLMES.id
}
