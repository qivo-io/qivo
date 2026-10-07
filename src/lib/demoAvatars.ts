import aisha from '../../scripts/demo/assets/aisha.jpg'
import atlas from '../../scripts/demo/assets/atlas.jpg'
import ben from '../../scripts/demo/assets/ben.jpg'
import daniel from '../../scripts/demo/assets/daniel.jpg'
import emil from '../../scripts/demo/assets/emil.jpg'
import leo from '../../scripts/demo/assets/leo.jpg'
import nora from '../../scripts/demo/assets/nora.jpg'
import sofia from '../../scripts/demo/assets/sofia.jpg'

const portraits = { aisha, atlas, ben, daniel, emil, leo, nora, sofia }

// Bundled fictional assets are public application files, never shared private
// storage IDs. Replacing one profile's upload cannot delete another portrait.
export function sampleAvatarUrl(key: string | undefined): string | null {
  return key && Object.hasOwn(portraits, key) ? portraits[key as keyof typeof portraits] : null
}
