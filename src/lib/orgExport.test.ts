import { getFunctionName } from 'convex/server'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
} from '../../convex/lib/orgExport'
import { exportOrganization, type OrgExportDependencies } from './orgExport'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./convex', () => ({ convex: { query } }))

const orgId = 'organization-one'
const attachmentBytes = new Uint8Array([0, 128, 255, 3, 4])
const avatarBytes = new Uint8Array([11, 12, 13])

function fixture() {
  const records: Partial<Record<OrgExportSection, OrgExportRow[]>> = {
    organizations: [{ id: orgId, name: 'Northstar Labs', slug: 'northstar-labs' }],
    teams: [{ id: 'team-one', org_id: orgId }],
    profiles: [
      { id: 'person-one', org_id: orgId, name: 'Nora', avatar_storage_id: 'avatar-storage' },
      { id: 'agent-one', org_id: orgId, name: 'Assistant', kind: 'agent' },
    ],
    projects: [{ id: 'project-one', org_id: orgId, archived_at: '2026-01-01T00:00:00Z' }],
    issues: [
      { id: 'issue-one', project_id: 'project-one', org_id: orgId, num: 14 },
      { id: 'issue-two', project_id: 'project-one', org_id: orgId, num: 26 },
      { id: 'issue-three', project_id: 'project-one', org_id: orgId, num: 301 },
    ],
    team_members: [{ team_id: 'team-one', profile_id: 'person-one', is_leader: true }],
    comments: [
      { id: 'comment-one', issue_id: 'issue-one', body: 'First' },
      { id: 'comment-two', issue_id: 'issue-one', body: 'Second' },
      { id: 'comment-three', issue_id: 'issue-three', body: 'Third' },
    ],
    issue_attachments: [
      {
        id: 'attachment-one',
        issue_id: 'issue-three',
        name: 'design.png',
        mime: 'image/png',
        size_bytes: attachmentBytes.length,
        storage_id: 'attachment-storage',
        inline: true,
      },
    ],
    agent_keys: [{ id: 'key-one', profile_id: 'agent-one', name: 'Automation', revoked: false }],
  }
  const page = vi.fn<OrgExportDependencies['page']>(async (args) => {
    let rows = records[args.section] ?? []
    if (args.parent_id !== undefined) {
      const parentField = {
        teams: 'team_id',
        profiles: 'profile_id',
        projects: 'project_id',
        issues: 'issue_id',
      }[ORG_EXPORT_SECTIONS[args.section]!]
      rows = rows.filter((row) => row[parentField] === args.parent_id)
    }
    // One record per page proves both organization and child-table pagination.
    const offset = args.cursor === null ? 0 : Number(args.cursor)
    return {
      rows: rows.slice(offset, offset + 1),
      continueCursor: String(offset + 1),
      isDone: offset + 1 >= rows.length,
    }
  })
  const mintUrls = vi.fn<OrgExportDependencies['mintUrls']>(async (args) => ({
    attachments: Object.fromEntries(
      (args.attachment_ids ?? []).map((id) => [
        id,
        { url: `https://files.example/files/${encodeURIComponent(id)}?t=secret-token`, exp: 99 },
      ]),
    ),
    avatars: Object.fromEntries(
      (args.profile_ids ?? []).map((id) => [
        id,
        {
          url: `https://files.example/avatars/${encodeURIComponent(id)}?v=avatar-storage&t=secret-token`,
          exp: 99,
        },
      ]),
    ),
  }))
  const fetchFile = vi.fn<OrgExportDependencies['fetch']>(async (url) => {
    const avatar = String(url).includes('/avatars/')
    const bytes = avatar ? avatarBytes : attachmentBytes
    // Split bodies into several chunks to exercise incremental byte handling.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1))
        controller.enqueue(bytes.slice(1))
        controller.close()
      },
    })
    return new Response(body, {
      headers: { 'content-type': avatar ? 'image/jpeg' : 'image/png' },
    })
  })
  const now = vi
    .fn()
    .mockReturnValueOnce(new Date('2026-09-13T10:00:00Z'))
    .mockReturnValue(new Date('2026-09-13T10:00:05Z'))
  const io: OrgExportDependencies = { page, mintUrls, fetch: fetchFile, now }
  return { records, page, mintUrls, fetchFile, io }
}

async function readArchive(blob: Blob) {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  const json = (path: string) => JSON.parse(strFromU8(entries[path]))
  return { entries, json, manifest: json('manifest.json') }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('organization export archive', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    query.mockReset()
  })

  it('exports avatar and attachment bytes with the default browser fetch dependencies', async () => {
    const { page, mintUrls, fetchFile } = fixture()
    query.mockImplementation((ref, args) => {
      switch (getFunctionName(ref)) {
        case 'orgExport:page':
          return page(args)
        case 'files:mintUrls':
          return mintUrls(args)
        default:
          throw new Error(`Unexpected query: ${getFunctionName(ref)}`)
      }
    })
    // Browser fetch rejects being invoked with the dependency object as `this`.
    const fetcher = vi.fn(function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined) throw new TypeError('Illegal invocation')
      return fetchFile(...args)
    })
    vi.stubGlobal('fetch', fetcher)

    const { blob } = await exportOrganization({ orgId })
    const { entries } = await readArchive(blob)
    expect(entries['files/attachments/attachment-one/design.png']).toEqual(attachmentBytes)
    expect(entries['files/avatars/person-one/avatar.jpg']).toEqual(avatarBytes)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('downloads signed attachment and avatar files through a forwarded local demo', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubEnv('VITE_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'http://127.0.0.1:3211')
    vi.stubGlobal('window', { location: new URL('http://localhost:58955') })
    const { io, fetchFile } = fixture()
    const mint = io.mintUrls
    io.mintUrls = async (args) => {
      const result = await mint(args)
      for (const group of [result.attachments, result.avatars])
        for (const file of Object.values(group))
          file.url = file.url.replace('https://files.example', 'http://127.0.0.1:3211')
      return result
    }
    const { blob } = await exportOrganization({ orgId }, io)
    const { entries } = await readArchive(blob)
    expect(fetchFile.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:58955/__qivo_http/avatars/person-one?v=avatar-storage&t=secret-token',
      'http://localhost:58955/__qivo_http/files/attachment-one?t=secret-token',
    ])
    expect(entries['files/attachments/attachment-one/design.png']).toEqual(attachmentBytes)
    expect(entries['files/avatars/person-one/avatar.jpg']).toEqual(avatarBytes)
  })

  it('exports paginated organization and child rows plus exact uploaded bytes in a portable ZIP', async () => {
    const { io, page, mintUrls, fetchFile, records } = fixture()
    const progress = vi.fn()
    const { blob, filename } = await exportOrganization({ orgId, onProgress: progress }, io)
    const { entries, json, manifest } = await readArchive(blob)

    expect(filename).toBe('qivo-northstar-labs-2026-09-13.zip')
    expect(blob.type).toBe('application/zip')
    expect(json('data/tasks.json')).toEqual(records.issues)
    expect(json('data/comments.json')).toEqual(
      records.comments!.map(({ issue_id, ...comment }) => ({ ...comment, task_id: issue_id })),
    )
    expect(json('data/agent_keys.json')).toEqual(records.agent_keys)
    expect(json('data/projects.json')[0].archived_at).toBe('2026-01-01T00:00:00Z')
    expect(entries['files/attachments/attachment-one/design.png']).toEqual(attachmentBytes)
    expect(entries['files/avatars/person-one/avatar.jpg']).toEqual(avatarBytes)
    expect(manifest).toMatchObject({
      format: 'qivo-organization-export',
      version: 2,
      organization: { id: orgId, name: 'Northstar Labs', slug: 'northstar-labs' },
      started_at: '2026-09-13T10:00:00.000Z',
      completed_at: '2026-09-13T10:00:05.000Z',
      consistency: 'live_read',
      tables: {
        tasks: { count: 3, path: 'data/tasks.json' },
        comments: { count: 3, path: 'data/comments.json' },
      },
    })
    expect(manifest.files).toEqual([
      {
        kind: 'avatar',
        id: 'person-one',
        storage_id: 'avatar-storage',
        original_name: 'avatar',
        mime: 'image/jpeg',
        path: 'files/avatars/person-one/avatar.jpg',
        size_bytes: avatarBytes.length,
      },
      {
        kind: 'attachment',
        id: 'attachment-one',
        storage_id: 'attachment-storage',
        original_name: 'design.png',
        mime: 'image/png',
        path: 'files/attachments/attachment-one/design.png',
        size_bytes: attachmentBytes.length,
      },
    ])
    expect(Object.keys(manifest.tables)).toEqual([
      'organizations',
      'teams',
      'profiles',
      'projects',
      'tasks',
      'labels',
      'activity_events',
      'team_members',
      'project_access',
      'project_team_access',
      'milestones',
      'task_links',
      'task_labels',
      'task_attachments',
      'comments',
      'agent_keys',
    ])
    const exportedTables = Object.values(manifest.tables) as Array<{ count: number; path: string }>
    for (const [index, { count, path }] of exportedTables.entries()) {
      const section = Object.keys(ORG_EXPORT_SECTIONS)[index] as OrgExportSection
      expect(json(path)).toHaveLength(count)
      expect(count).toBe(records[section]?.length ?? 0)
    }
    expect(page).toHaveBeenCalledWith({ org_id: orgId, section: 'issues', cursor: '2' })
    expect(page).toHaveBeenCalledWith({
      org_id: orgId,
      section: 'comments',
      parent_id: 'issue-one',
      cursor: '1',
    })
    expect(page).toHaveBeenLastCalledWith({ org_id: orgId, section: 'organizations', cursor: null })
    expect(mintUrls).toHaveBeenCalledTimes(2)
    expect(fetchFile).toHaveBeenCalledTimes(2)
    // Mint one file just before its fetch; URLs are never collected in advance.
    expect(mintUrls.mock.invocationCallOrder[0]).toBeLessThan(fetchFile.mock.invocationCallOrder[0])
    expect(fetchFile.mock.invocationCallOrder[0]).toBeLessThan(mintUrls.mock.invocationCallOrder[1])
    expect(progress).toHaveBeenCalledWith('Downloading files, 2 of 2')
    expect(progress).toHaveBeenCalledWith('Collecting tasks, 0 records')
    expect(progress).toHaveBeenCalledWith('Collecting task attachments, 0 records')
    expect(progress.mock.calls.flat().join(' ')).not.toMatch(/\bissues?\b/)
    expect(progress).toHaveBeenLastCalledWith('Finishing export…')
  })

  it('exports task references and activity types while preserving user content and source rows', async () => {
    const { io, records } = fixture()
    records.organizations![0].next_issue_num = 302
    records.issue_labels = [{ issue_id: 'issue-one', label_id: 'label-one' }]
    records.activity_events = [
      {
        id: 'activity-one',
        target_type: 'issue',
        target_id: 'issue-one',
        label: 'Investigate the connection issue',
        detail: 'The report says "issue_id".',
      },
      { id: 'activity-two', target_type: 'project', target_id: 'project-one' },
    ]
    const before = structuredClone(records)
    const { blob } = await exportOrganization({ orgId }, io)
    const { entries, json } = await readArchive(blob)

    expect(json('data/organizations.json')[0]).toEqual({
      id: orgId,
      name: 'Northstar Labs',
      slug: 'northstar-labs',
      next_task_num: 302,
    })
    expect(json('data/task_labels.json')).toEqual([{ task_id: 'issue-one', label_id: 'label-one' }])
    const { issue_id: _issueId, ...attachment } = before.issue_attachments![0]
    expect(json('data/task_attachments.json')[0]).toEqual({
      ...attachment,
      task_id: 'issue-three',
    })
    expect(json('data/task_attachments.json')[0]).not.toHaveProperty('issue_id')
    expect(json('data/activity_events.json')).toEqual([
      { ...before.activity_events![0], target_type: 'task' },
      before.activity_events![1],
    ])
    expect(Object.keys(entries).some((path) => /data\/issues?(?:_|\.)/.test(path))).toBe(false)
    expect(records).toEqual(before)
  })

  it('records the exclusions and reference format without archiving temporary URLs', async () => {
    const { io } = fixture()
    const { blob } = await exportOrganization({ orgId }, io)
    const { entries, manifest } = await readArchive(blob)
    expect(Object.keys(entries)).toHaveLength(Object.keys(ORG_EXPORT_SECTIONS).length + 4)
    expect(
      Object.keys(entries).some((name) => /data\/(messages|mcp_tokens|user_prefs)/.test(name)),
    ).toBe(false)
    expect(manifest.exclusions.join(' ')).toMatch(/task_subscriptions/)
    expect(manifest.exclusions.join(' ')).toMatch(/messages/)
    expect(manifest.exclusions.join(' ')).toMatch(/user_prefs/)
    expect(manifest.exclusions.join(' ')).toMatch(/mcp_tokens/)
    expect(manifest.exclusions.join(' ')).toMatch(/Authentication/)
    expect(manifest.exclusions.join(' ')).toMatch(/Platform/)
    expect(manifest.exclusions.join(' ')).toMatch(/Gravatar/)
    expect(JSON.stringify(manifest)).not.toMatch(/secret-token|files\.example/)
    const readme = strFromU8(entries['README.txt'])
    expect(readme).toContain('format version 2')
    expect(readme).toContain('task_id')
    expect(readme).not.toMatch(/\bissues?\b|issue_/)
    expect(readme).toContain('att:<attachment UUID>')
    expect(readme).toContain('not an atomic snapshot')
    expect(readme).toContain('does not\ncurrently provide an import or restore')
  })

  it('keeps malicious filenames and unexpected IDs inside their file directories', async () => {
    const { io, records } = fixture()
    records.issue_attachments![0].id = '../..\\attachment'
    records.issue_attachments![0].name = '../../..\\CON.txt'
    const { blob } = await exportOrganization({ orgId }, io)
    const { entries, manifest, json } = await readArchive(blob)
    const attachment = manifest.files.find((file: { kind: string }) => file.kind === 'attachment')
    expect(attachment.path).toBe('files/attachments/%2E%2E%2F%2E%2E%5Cattachment/file-CON.txt')
    expect(entries[attachment.path]).toEqual(attachmentBytes)
    expect(attachment.original_name).toBe('../../..\\CON.txt')
    expect(json('data/task_attachments.json')[0].name).toBe('../../..\\CON.txt')
    for (const path of Object.keys(entries)) {
      expect(path.startsWith('/')).toBe(false)
      expect(path).not.toContain('\\')
      expect(path.split('/')).not.toContain('..')
    }
  })

  it.each(['unmintable', 'http', 'truncated', 'stream'])(
    'fails the entire export when an uploaded file is %s',
    async (failure) => {
      const { io, mintUrls, fetchFile, page } = fixture()
      if (failure === 'unmintable') mintUrls.mockResolvedValueOnce({ attachments: {}, avatars: {} })
      if (failure === 'http') fetchFile.mockResolvedValueOnce(new Response(null, { status: 404 }))
      if (failure === 'truncated') {
        fetchFile.mockResolvedValueOnce(new Response(avatarBytes))
        fetchFile.mockResolvedValueOnce(new Response(attachmentBytes.slice(0, 2)))
      }
      if (failure === 'stream') {
        fetchFile.mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('Network disconnected'))
              },
            }),
          ),
        )
      }
      await expect(exportOrganization({ orgId }, io)).rejects.toThrow(
        /Could not export .*Retry the export/,
      )
      expect(page.mock.calls.filter(([args]) => args.section === 'organizations')).toHaveLength(1)
    },
  )

  it('fails if an avatar was replaced since its profile was read', async () => {
    const { io, mintUrls, fetchFile } = fixture()
    mintUrls.mockResolvedValueOnce({
      attachments: {},
      avatars: { 'person-one': { url: 'https://files.example/avatar?v=new-storage', exp: 999 } },
    })
    await expect(exportOrganization({ orgId }, io)).rejects.toThrow(
      'avatar changed during the export',
    )
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('preserves attachment MIME when the gateway uses a generic download content type', async () => {
    const { io, records, fetchFile } = fixture()
    records.issue_attachments![0].mime = 'application/pdf'
    fetchFile.mockResolvedValueOnce(
      new Response(avatarBytes, { headers: { 'content-type': 'image/png' } }),
    )
    fetchFile.mockResolvedValueOnce(
      new Response(attachmentBytes, { headers: { 'content-type': 'application/octet-stream' } }),
    )
    const { blob } = await exportOrganization({ orgId }, io)
    const { manifest } = await readArchive(blob)
    expect(manifest.files.find((file: { kind: string }) => file.kind === 'attachment').mime).toBe(
      'application/pdf',
    )
  })

  it('fails when administrator access is revoked before completion', async () => {
    const { io, page } = fixture()
    const originalPage = io.page
    let orgReads = 0
    io.page = async (args) => {
      if (args.section === 'organizations' && ++orgReads === 2) {
        throw new Error('organization administrator required')
      }
      return originalPage(args)
    }
    await expect(exportOrganization({ orgId }, io)).rejects.toThrow(
      'organization administrator required',
    )
    expect(page).toHaveBeenCalled()
  })

  it('rejects already cancelled exports without making requests', async () => {
    const { io, page } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      exportOrganization({ orgId, signal: controller.signal }, io),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(page).not.toHaveBeenCalled()
  })

  it('stops promptly while waiting on a Convex page that cannot be cancelled', async () => {
    const { io, page, mintUrls } = fixture()
    const controller = new AbortController()
    page.mockReturnValueOnce(new Promise(() => {}))
    const exporting = exportOrganization({ orgId, signal: controller.signal }, io)
    controller.abort()
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
    expect(page).toHaveBeenCalledTimes(1)
    expect(mintUrls).not.toHaveBeenCalled()
  })

  it('cancels the active body stream and never starts another file', async () => {
    const { io, fetchFile, mintUrls } = fixture()
    const controller = new AbortController()
    const cancelled = vi.fn()
    fetchFile.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                controller.abort()
              },
              cancel: cancelled,
            },
            { highWaterMark: 0 },
          ),
        ),
    )
    await expect(
      exportOrganization({ orgId, signal: controller.signal }, io),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(mintUrls).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('refuses a repeating pagination cursor instead of silently truncating data', async () => {
    const { io, page, mintUrls } = fixture()
    page.mockResolvedValue({ rows: [], continueCursor: 'same-cursor', isDone: false })
    await expect(exportOrganization({ orgId }, io)).rejects.toThrow('Pagination stalled')
    expect(page).toHaveBeenCalledTimes(2)
    expect(mintUrls).not.toHaveBeenCalled()
  })

  it('overlaps at most four parent first pages while preserving parent and pagination order', async () => {
    const { io, records, page } = fixture()
    const issueIds = Array.from({ length: 7 }, (_, index) => `parallel-${index}`)
    records.issues = issueIds.map((id) => ({ id, org_id: orgId }))
    records.comments = issueIds.flatMap((issue_id, index) => [
      { id: `comment-${index}`, issue_id },
      ...(index === 0 ? [{ id: 'comment-0-next-page', issue_id }] : []),
    ])
    records.issue_attachments = []
    const gates = issueIds.map(() => deferred<void>())
    const firstBatchStarted = deferred<void>()
    const secondBatchStarted = deferred<void>()
    const started: string[] = []
    let active = 0
    let maxActive = 0
    io.page = async (args) => {
      if (args.section === 'comments' && args.cursor === null) {
        const index = issueIds.indexOf(args.parent_id!)
        started.push(args.parent_id!)
        active++
        maxActive = Math.max(active, maxActive)
        if (started.length === 4) firstBatchStarted.resolve()
        if (started.length === 7) secondBatchStarted.resolve()
        await gates[index].promise
        active--
      }
      return page(args)
    }
    const exporting = exportOrganization({ orgId }, io)
    await firstBatchStarted.promise
    expect(started).toEqual(issueIds.slice(0, 4))
    expect(active).toBe(4)
    // Complete out of order. The next batch must wait for the slow first parent.
    gates[3].resolve()
    gates[2].resolve()
    gates[1].resolve()
    await Promise.resolve()
    expect(started).toEqual(issueIds.slice(0, 4))
    gates[0].resolve()
    await secondBatchStarted.promise
    expect(active).toBe(3)
    expect(page).toHaveBeenCalledWith({
      org_id: orgId,
      section: 'comments',
      parent_id: issueIds[0],
      cursor: '1',
    })
    gates[6].resolve()
    gates[5].resolve()
    gates[4].resolve()
    const { blob } = await exporting
    const { json } = await readArchive(blob)
    expect(maxActive).toBe(4)
    expect(active).toBe(0)
    expect(json('data/comments.json')).toEqual(
      records.comments!.map(({ issue_id, ...comment }) => ({ ...comment, task_id: issue_id })),
    )
  })

  it('settles every parent in a failed batch before refusing the archive and starting no later pages', async () => {
    const { io, records, page, mintUrls } = fixture()
    const issueIds = Array.from({ length: 4 }, (_, index) => `failing-${index}`)
    records.issues = issueIds.map((id) => ({ id, org_id: orgId }))
    records.issue_attachments = []
    const gates = issueIds.map(() => deferred<OrgExportPage>())
    const batchStarted = deferred<void>()
    let started = 0
    io.page = async (args) => {
      if (args.section === 'comments' && args.cursor === null) {
        if (++started === 4) batchStarted.resolve()
        return gates[issueIds.indexOf(args.parent_id!)].promise
      }
      return page(args)
    }
    const progress = vi.fn()
    const exporting = exportOrganization({ orgId, onProgress: progress }, io)
    const settled = vi.fn()
    void exporting.then(settled, settled)
    await batchStarted.promise
    gates[1].reject(new Error('First parent refusal'))
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    gates[0].resolve({ rows: [{ id: 'first' }], continueCursor: 'next', isDone: false })
    gates[2].resolve({ rows: [], continueCursor: '', isDone: true })
    gates[3].reject(new Error('Another parent refusal'))
    await expect(exporting).rejects.toThrow('First parent refusal')
    expect(page.mock.calls.some(([args]) => args.section === 'comments')).toBe(false)
    expect(page.mock.calls.some(([args]) => args.section === 'agent_keys')).toBe(false)
    expect(mintUrls).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalledWith('Finishing export…')
  })
})
