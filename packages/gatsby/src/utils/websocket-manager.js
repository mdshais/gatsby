// @flow

const path = require(`path`)
const { store } = require(`../redux`)
const fs = require(`fs`)
const pageDataUtil = require(`../utils/page-data`)
const telemetry = require(`gatsby-telemetry`)
const url = require(`url`)
const { createHash } = require(`crypto`)

type QueryResult = {
  id: string,
  result: object,
}

type QueryResultsMap = Map<string, QueryResult>

/**
 * Get cached page query result for given page path.
 * @param {string} pagePath Path to a page.
 * @param {string} directory Root directory of current project.
 */
const getCachedPageData = async (
  pagePath: string,
  directory: string
): QueryResult => {
  const { program } = store.getState()
  const publicDir = path.join(program.directory, `public`)
  try {
    const pageData = await pageDataUtil.read({ publicDir }, pagePath)
    return {
      result: pageData.result,
      id: pagePath,
    }
  } catch (err) {
    console.log(
      `Error loading a result for the page query in "${pagePath}". Query was not run and no cached result was found.`
    )
    return undefined
  }
}

const hashPaths = paths => {
  if (!paths) {
    return undefined
  }
  return paths.map(path => {
    if (!path) {
      return undefined
    }
    return createHash(`sha256`)
      .update(path)
      .digest(`hex`)
  })
}

/**
 * Get cached StaticQuery results for components that Gatsby didn't run query yet.
 * @param {QueryResultsMap} resultsMap Already stored results for queries that don't need to be read from files.
 * @param {string} directory Root directory of current project.
 */
const getCachedStaticQueryResults = (
  resultsMap: QueryResultsMap,
  directory: string
): QueryResultsMap => {
  const cachedStaticQueryResults = new Map()
  const { staticQueryComponents } = store.getState()
  staticQueryComponents.forEach(staticQueryComponent => {
    // Don't read from file if results were already passed from query runner
    if (resultsMap.has(staticQueryComponent.hash)) return
    const filePath = path.join(
      directory,
      `public`,
      `static`,
      `d`,
      `${staticQueryComponent.hash}.json`
    )
    const fileResult = fs.readFileSync(filePath, `utf-8`)
    if (fileResult === `undefined`) {
      console.log(
        `Error loading a result for the StaticQuery in "${
          staticQueryComponent.componentPath
        }". Query was not run and no cached result was found.`
      )
      return
    }
    cachedStaticQueryResults.set(staticQueryComponent.hash, {
      result: JSON.parse(fileResult),
      id: staticQueryComponent.hash,
    })
  })
  return cachedStaticQueryResults
}

const getRoomNameFromPath = (path: string): string => `path-${path}`

class WebsocketManager {
  pageResults: QueryResultsMap
  staticQueryResults: QueryResultsMap
  errors: Map<string, QueryResult>
  isInitialised: boolean
  activePaths: Set<string>
  programDir: string

  constructor() {
    this.isInitialised = false
    this.activePaths = new Set()
    this.pageResults = new Map()
    this.staticQueryResults = new Map()
    this.errors = new Map()
    // this.websocket
    // this.programDir

    this.init = this.init.bind(this)
    this.getSocket = this.getSocket.bind(this)
    this.emitPageData = this.emitPageData.bind(this)
    this.emitStaticQueryData = this.emitStaticQueryData.bind(this)
    this.emitError = this.emitError.bind(this)
    this.connectedClients = 0
  }

  init({ server, directory }) {
    this.programDir = directory

    const cachedStaticQueryResults = getCachedStaticQueryResults(
      this.staticQueryResults,
      this.programDir
    )
    this.staticQueryResults = new Map([
      ...this.staticQueryResults,
      ...cachedStaticQueryResults,
    ])

    this.websocket = require(`socket.io`)(server)

    this.websocket.on(`connection`, s => {
      let activePath = null
      if (
        s &&
        s.handshake &&
        s.handshake.headers &&
        s.handshake.headers.referer
      ) {
        const path = url.parse(s.handshake.headers.referer).path
        if (path) {
          activePath = path
          this.activePaths.add(path)
        }
      }

      this.connectedClients += 1
      // Send already existing static query results
      this.staticQueryResults.forEach(result => {
        this.websocket.send({
          type: `staticQueryResult`,
          payload: result,
        })
      })
      this.errors.forEach((message, errorID) => {
        this.websocket.send({
          type: `overlayError`,
          payload: {
            id: errorID,
            message,
          },
        })
      })

      const leaveRoom = path => {
        s.leave(getRoomNameFromPath(path))
        const leftRoom = this.websocket.sockets.adapter.rooms[
          getRoomNameFromPath(path)
        ]
        if (!leftRoom || leftRoom.length === 0) {
          this.activePaths.delete(path)
        }
      }

      const getDataForPath = async path => {
        if (!this.pageResults.has(path)) {
          const result = await getCachedPageData(path, this.programDir)
          if (result) {
            this.pageResults.set(path, result)
          } else {
            console.log(`Page not found`, path)
            return
          }
        }

        this.websocket.send({
          type: `pageQueryResult`,
          why: `getDataForPath`,
          payload: this.pageResults.get(path),
        })

        telemetry.trackCli(
          `WEBSOCKET_PAGE_DATA_UPDATE`,
          {
            siteMeasurements: {
              clientsCount: this.connectedClients,
              paths: hashPaths(Array.from(this.activePaths)),
            },
          },
          { debounce: true }
        )
      }

      s.on(`getDataForPath`, getDataForPath)

      s.on(`registerPath`, path => {
        s.join(getRoomNameFromPath(path))
        activePath = path
        this.activePaths.add(path)
      })

      s.on(`disconnect`, s => {
        leaveRoom(activePath)
        this.connectedClients -= 1
      })

      s.on(`unregisterPath`, path => {
        leaveRoom(path)
      })
    })

    this.isInitialised = true
  }

  getSocket() {
    return this.isInitialised && this.websocket
  }

  emitStaticQueryData(data: QueryResult) {
    this.staticQueryResults.set(data.id, data)
    if (this.isInitialised) {
      this.websocket.send({ type: `staticQueryResult`, payload: data })
      telemetry.trackCli(
        `WEBSOCKET_EMIT_STATIC_PAGE_DATA_UPDATE`,
        {
          siteMeasurements: {
            clientsCount: this.connectedClients,
            paths: hashPaths(Array.from(this.activePaths)),
          },
        },
        { debounce: true }
      )
    }
  }

  emitPageData(data: QueryResult) {
    this.pageResults.set(data.id, data)
    if (this.isInitialised) {
      this.websocket.send({ type: `pageQueryResult`, payload: data })
      telemetry.trackCli(
        `WEBSOCKET_EMIT_PAGE_DATA_UPDATE`,
        {
          siteMeasurements: {
            clientsCount: this.connectedClients,
            paths: hashPaths(Array.from(this.activePaths)),
          },
        },
        { debounce: true }
      )
    }
  }
  emitError(id: string, message?: string) {
    if (message) {
      this.errors.set(id, message)
    } else {
      this.errors.delete(id)
    }

    if (this.isInitialised) {
      this.websocket.send({ type: `overlayError`, payload: { id, message } })
    }
  }
}

const manager = new WebsocketManager()

module.exports = manager
