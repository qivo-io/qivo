type UpdatePromptOptions = {
  isAvailable: () => boolean
  isBlocked: () => boolean
  confirmInstall: () => Promise<boolean>
  install: () => void
  showNotification: (version: string, onClick: () => void) => boolean
}

export function createUpdatePrompt(options: UpdatePromptOptions) {
  let notifiedVersion: string | undefined

  const install = async (): Promise<boolean> => {
    if (options.isBlocked()) {
      notifiedVersion = undefined
      return false
    }
    if (!options.isAvailable() || !(await options.confirmInstall())) return false
    // Drafts or operations can start while the native confirmation is open.
    if (options.isBlocked()) {
      notifiedVersion = undefined
      return false
    }
    if (!options.isAvailable()) return false
    options.install()
    return true
  }

  const notify = (version: string): void => {
    if (notifiedVersion === version || options.isBlocked() || !options.isAvailable()) return
    try {
      if (options.showNotification(version, () => void install())) notifiedVersion = version
    } catch {
      // A failed notification can be offered again when the next blocker clears.
    }
  }

  return { install, notify }
}
