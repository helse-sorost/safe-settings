const path = require('path')
const Glob = require('./glob')
const NopCommand = require('./nopcommand')
const MergeDeep = require('./mergeDeep')
const Archive = require('./plugins/archive')
const ResultHandler = require('./resultHandler')
const env = require('./env')
const CONFIG_PATH = env.CONFIG_PATH
const SCOPE = { ORG: 'org', REPO: 'repo' } // Determine if the setting is a org setting or repo setting

class Settings {
  static async syncAll (nop, context, repo, config, ref) {
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      await settings.loadConfigs()
      // settings.repoConfigs = await settings.getRepoConfigs()
      await settings.updateOrg()
      await settings.updateAll()
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
    return settings
  }

  static async syncSubOrgs (nop, context, suborg, repo, config, ref) {
    const settings = new Settings(nop, context, repo, config, ref, suborg)
    try {
      await settings.loadConfigs()
      await settings.updateAll()
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  static async sync (nop, context, repo, config, ref) {
    const settings = new Settings(nop, context, repo, config, ref)
    try {
      await settings.loadConfigs(repo)
      if (settings.isRestricted(repo.repo)) {
        return
      }
      await settings.updateRepos(repo)
      await settings.handleResults()
    } catch (error) {
      settings.logError(error.message)
      await settings.handleResults()
    }
  }

  constructor (nop, context, repo, config, ref, suborg) {
    this.ref = ref
    this.context = context
    this.installation_id = context.payload.installation.id
    this.github = context.octokit
    this.repo = repo
    this.config = config
    this.nop = nop
    this.suborgChange = !!suborg
    // If suborg config has been updated, do not load the entire suborg config, and only process repos restricted to it.
    if (suborg) {
      this.subOrgConfigMap = [suborg]
    }
    this.log = context.log
    this.resultHandler = new ResultHandler(nop, context, repo)
    this.errors = []
    this.configvalidators = {}
    this.overridevalidators = {}
    const overridevalidators = config.overridevalidators
    if (this.isIterable(overridevalidators)) {
      for (const validator of overridevalidators) {
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'overrideconfig', 'githubContext', validator.script)
        this.overridevalidators[validator.plugin] = { canOverride: f, error: validator.error }
      }
    }
    const configvalidators = config.configvalidators
    if (this.isIterable(configvalidators)) {
      for (const validator of configvalidators) {
        this.log.debug(`Logging each script: ${typeof validator.script}`)
        // eslint-disable-next-line no-new-func
        const f = new Function('baseconfig', 'githubContext', validator.script)
        this.configvalidators[validator.plugin] = { isValid: f, error: validator.error }
      }
    }
    this.mergeDeep = new MergeDeep(this.log, this.github, [], this.configvalidators, this.overridevalidators)
  }

  logError (msg) {
    this.log.error(msg)
    this.errors.push({
      owner: this.repo.owner,
      repo: this.repo.repo,
      msg,
      plugin: this.constructor.name
    })
  }

  async handleResults () {
    this.resultHandler.handleResults(this.errors)
  }

  async loadConfigs (repo) {
    this.subOrgConfigs = await this.getSubOrgConfigs()
    this.repoConfigs = await this.getRepoConfigs(repo)
  }

  async updateOrg () {
    const rulesetsConfig = this.config.rulesets
    if (rulesetsConfig) {
      const RulesetsPlugin = Settings.PLUGINS.rulesets
      const res = await new RulesetsPlugin(this.nop, this.github, this.repo, rulesetsConfig, this.log, this.errors, SCOPE.ORG).sync()
      this.resultHandler.appendToResults(res)
    }
  }

  async updateRepos (repo) {
    this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs()
    let repoConfig = this.config.repository
    if (repoConfig) {
      repoConfig = Object.assign(repoConfig, { name: repo.repo, org: repo.owner })
    }

    const subOrgConfig = this.getSubOrgConfig(repo.repo)

    // If suborg config has been updated then only restrict to the repos for that suborg
    if (this.subOrgConfigMap && !subOrgConfig) {
      this.log.debug(`Skipping... SubOrg config changed but this repo is not part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)
      return
    }

    this.log.debug(`Process normally... Not a SubOrg config change or SubOrg config was changed and this repo is part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.subOrgConfigMap)}`)

    if (subOrgConfig) {
      let suborgRepoConfig = subOrgConfig.repository
      if (suborgRepoConfig) {
        suborgRepoConfig = Object.assign(suborgRepoConfig, { name: repo.repo, org: repo.owner })
        repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, suborgRepoConfig)
      }
    }

    // Overlay repo config
    // RepoConfigs should be preloaded but checking anyway
    const overrideRepoConfig = this.repoConfigs[`${repo.repo}.yml`]?.repository
    if (overrideRepoConfig) {
      repoConfig = this.mergeDeep.mergeDeep({}, repoConfig, overrideRepoConfig)
    }
    const { shouldContinue, nopCommands } = await new Archive(this.nop, this.github, repo, repoConfig, this.log).sync()
    if (nopCommands) this.resultHandler.appendToResults(nopCommands)
    if (shouldContinue) {
      try {
        const childPlugins = this.childPluginsList(repo)
        if (repoConfig) {
          this.log.debug(`found a matching repoconfig for this repo ${JSON.stringify(repoConfig)}`)
          const RepoPlugin = Settings.PLUGINS.repository
          const res = await new RepoPlugin(this.nop, this.github, repo, repoConfig, this.installation_id, this.log, this.errors).sync()
          this.resultHandler.appendToResults(res)
        } else {
          this.log.debug(`Didnt find any a matching repoconfig for this repo ${JSON.stringify(repo)} in ${JSON.stringify(this.repoConfigs)}`)
        }
        const res = await Promise.all(childPlugins.map(async ([Plugin, config]) => {
          return await new Plugin(this.nop, this.github, repo, config, this.log, this.errors).sync()
        }))
        this.resultHandler.appendToResults(res)
      } catch (e) {
        if (this.nop) {
          const nopcommand = new NopCommand(this.constructor.name, this.repo, null, `${e}`, 'ERROR')
          this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
          this.resultHandler.appendToResults([nopcommand])
          // throw e
        } else {
          throw e
        }
      }
    }
  }

  async updateAll () {
    this.log.debug('Fetching repositories')

    const processedRepos = new Set()

    // Process existing repositories
    const existingRepoResults = await this.github.paginate('GET /installation/repositories')
    await Promise.all(existingRepoResults.map(async repository => {
      if (this.isRestricted(repository.name)) {
        return
      }

      const { owner, name } = repository
      processedRepos.add(`${owner.login}/${name}`)
      await this.updateRepos({ owner: owner.login, repo: name })
    }))

    // Process missing repositories
    const repoInConfigs = Object.values(this.repoConfigs)
      .filter(config => config.repository?.name)
      .map(config => {
        return {
          name: config.repository.name,
          owner: config.repository.organization || this.repo.owner
        }
      })
    await Promise.all(
      repoInConfigs
        .filter(repo => !this.isRestricted(repo.name))
        .filter(repo => !processedRepos.has(`${repo.owner}/${repo.name}`))
        .map(async repo => {
          processedRepos.add(`${repo.owner}/${repo.name}`)
          await this.updateRepos({ owner: repo.owner, repo: repo.name })
        })
    )
  }

  getSubOrgConfig (repoName) {
    if (this.subOrgConfigs) {
      for (const k of Object.keys(this.subOrgConfigs)) {
        const repoPattern = new Glob(k)
        if (repoName.search(repoPattern) >= 0) {
          return this.subOrgConfigs[k]
        }
      }
    }
    return undefined
  }

  // Remove Org specific configs from the repo config
  returnRepoSpecificConfigs (config) {
    const newConfig = Object.assign({}, config) // clone
    delete newConfig.rulesets
    return newConfig
  }

  childPluginsList (repo) {
    const repoName = repo.repo
    const subOrgOverrideConfig = this.getSubOrgConfig(repoName)
    this.log.debug(`suborg config for ${repoName}  is ${JSON.stringify(subOrgOverrideConfig)}`)
    const repoOverrideConfig = this.repoConfigs[`${repoName}.yml`] || {}
    const overrideConfig = this.mergeDeep.mergeDeep({}, this.returnRepoSpecificConfigs(this.config), subOrgOverrideConfig, repoOverrideConfig)

    this.log.debug(`consolidated config is ${JSON.stringify(overrideConfig)}`)

    const childPlugins = []
    for (const [section, config] of Object.entries(overrideConfig)) {
      const baseConfig = this.config[section]
      if (Array.isArray(baseConfig) && Array.isArray(config)) {
        for (const baseEntry of baseConfig) {
          const newEntry = config.find(e => e.name === baseEntry.name)
          this.validate(section, baseEntry, newEntry)
        }
      } else {
        this.validate(section, baseConfig, config)
      }
      if (section !== 'repositories' && section !== 'repository') {
        // Ignore any config that is not a plugin
        if (section in Settings.PLUGINS) {
          this.log.debug(`Found section ${section} in the config. Creating plugin...`)
          const Plugin = Settings.PLUGINS[section]
          childPlugins.push([Plugin, config])
        }
      }
    }
    return childPlugins
  }

  validate (section, baseConfig, overrideConfig) {
    const configValidator = this.configvalidators[section]
    if (configValidator) {
      this.log.debug(`Calling configvalidator for key ${section} `)
      if (!configValidator.isValid(overrideConfig, this.github)) {
        this.log.error(`Error in calling configvalidator for key ${section} ${configValidator.error}`)
        throw new Error(configValidator.error)
      }
    }
    const overridevalidator = this.overridevalidators[section]
    if (overridevalidator) {
      this.log.debug(`Calling overridevalidator for key ${section} `)
      if (!overridevalidator.canOverride(baseConfig, overrideConfig, this.github)) {
        this.log.error(`Error in calling overridevalidator for key ${section} ${overridevalidator.error}`)
        throw new Error(overridevalidator.error)
      }
    }
  }

  isRestricted (repoName) {
    const restrictedRepos = this.config.restrictedRepos
    // Skip configuring any restricted repos
    if (Array.isArray(restrictedRepos)) {
      // For backward compatibility support the old format
      if (restrictedRepos.includes(repoName)) {
        this.log.debug(`Skipping retricted repo ${repoName}`)
        return true
      } else {
        this.log.debug(`${repoName} not in restricted repos ${restrictedRepos}`)
        return false
      }
    } else if (Array.isArray(restrictedRepos.include)) {
      if (this.includesRepo(repoName, restrictedRepos.include)) {
        this.log.debug(`Allowing ${repoName} in restrictedRepos.include [${restrictedRepos.include}]`)
        return false
      } else {
        this.log.debug(`Skipping repo ${repoName} not in restrictedRepos.include`)
        return true
      }
    } else if (Array.isArray(restrictedRepos.exclude)) {
      if (this.includesRepo(repoName, restrictedRepos.exclude)) {
        this.log.debug(`Skipping excluded repo ${repoName} in restrictedRepos.exclude`)
        return true
      } else {
        this.log.debug(`Allowing ${repoName} not in restrictedRepos.exclude [${restrictedRepos.exclude}]`)
        return false
      }
    }
    return false
  }

  includesRepo (repoName, restrictedRepos) {
    return restrictedRepos.filter((restrictedRepo) => { return RegExp(restrictedRepo).test(repoName) }).length > 0
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadConfigMap (params) {
    try {
      this.log.debug(` In loadConfigMap ${JSON.stringify(params)}`)
      const response = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!response) {
        return []
      }
      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        // const overrides = new Map()
        const overrides = response.data.map(d => { return { name: d.name, path: d.path } })
        // response.data.forEach(d =>  overrides.set(d.name, d.path))
        return overrides
      }
      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }
      const yaml = require('js-yaml')
      return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand('settings', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.resultHandler.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getRepoConfigMap () {
    try {
      this.log.debug(` In getRepoConfigMap ${JSON.stringify(this.repo)}`)
      // GitHub getContent api has a hard limit of returning 1000 entries without
      // any pagination. They suggest to use Tree api.
      // https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content

      // get <CONFIG_PATH>/repos directory sha to use in the getTree api
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH), ref: this.ref })
      const githubDirectoryContentResponse = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!githubDirectoryContentResponse) {
        throw new Error(`Error reading ${CONFIG_PATH} directory`)
      }

      const githubDirContent = githubDirectoryContentResponse.data
      const repoDirInfo = githubDirContent.filter(dir => dir.name === 'repos')[0]
      if (!repoDirInfo) {
        this.log.debug(`No repos directory in the ${env.ADMIN_REPO}/${CONFIG_PATH}`)
        return []
      }

      // read the repo contents using tree
      this.log.debug(`repos directory info ${JSON.stringify(repoDirInfo)}`)
      // const endpoint = `/repos/${this.repo.owner}/${repo.repo}/git/trees/${repoDirInfo.sha}`
      // this.log.debug(`endpoint: ${endpoint}`)
      const treeParams = Object.assign(repo, { tree_sha: repoDirInfo.sha, recursive: 0 })
      const response = await this.github.git.getTree(treeParams).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(this.github.git.getTree.endpoint(treeParams))} ${e}`)
      })

      if (!response || !response.data) {
        this.log.debug('repos directory exist but reading the tree failed')
        throw new Error('exception while reading the repos directory')
      }
      // throw error if truncated is true.
      if (response.data.truncated) {
        this.log.debug('not all repo files in  directory are read')
        throw new Error('not all repo files in  directory are read')
      }
      const treeInfo = response.data.tree
      // we emulated the existing loadConfigMap function as is by returning the
      // the same overrides list. This way the overall changes are minimal
      const overrides = treeInfo.map(d => { return { name: d.path, path: path.posix.join(CONFIG_PATH, 'repos', d.path) } })
      this.log.debug('Total overrides found in getRepoConfigMap are ' + overrides.length)
      return overrides
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getRepoConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.resultHandler.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigMap () {
    try {
      this.log.debug(` In getSubOrgConfigMap ${JSON.stringify(this.repo)}`)
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH, 'suborgs'), ref: this.ref })

      const response = await this.loadConfigMap(params)
      return response
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigMap', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * If repo param is null load configs for all repos
   * If repo param is null and suborg change, load configs for suborg repos only
   * If repo partam is not null, load the config for a specific repo
   * @param {*} repo repo param
   * @returns repoConfigs object
   */
  async getRepoConfigs (repo) {
    try {
      const overridePaths = await this.getRepoConfigMap()
      const repoConfigs = {}

      for (const override of overridePaths) {
        // Don't load if already loaded
        if (repoConfigs[override.name]) {
          continue
        }
        // If repo is passed get only its config
        // else load all the config
        if (repo) {
          if (override.name === `${repo.repo}.yml`) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else if (this.suborgChange) {
          // If suborg change, only load repos that are part of the suborg
          if (this.getSubOrgConfig(override.name.split('.')[0])) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else {
          const data = await this.loadYaml(override.path)
          this.log.debug(`data = ${JSON.stringify(data)}`)
          repoConfigs[override.name] = data
        }
      }
      this.log.debug(`repo configs = ${JSON.stringify(repoConfigs)}`)
      return repoConfigs
    } catch (e) {
      if (this.nop) {
        this.log.error(e)
        const nopcommand = new NopCommand('getRepoConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.resultHandler.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async getSubOrgConfigs () {
    try {
      // Get all suborg configs even though we might be here becuase of a suborg config change
      // we will filter them out if request is due to a suborg config change
      const overridePaths = await this.getSubOrgConfigMap()
      const subOrgConfigs = {}

      for (const override of overridePaths) {
        const data = await this.loadYaml(override.path)
        this.log.debug(`data = ${JSON.stringify(data)}`)

        if (!data) { return subOrgConfigs }

        subOrgConfigs[override.name] = data
        if (data.suborgrepos) {
          data.suborgrepos.forEach(repository => {
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repository, data)

            // In case support for multiple suborg configs for the same repo is required, merge the configs.
            //
            // Planned for the future to support multiple suborgrepos for the same repo
            //
            // if (existingConfigForRepo) {
            //   subOrgConfigs[repository] = this.mergeDeep.mergeDeep({}, existingConfigForRepo, data)
            // } else {
            //   subOrgConfigs[repository] = data
            // }

            subOrgConfigs[repository] = Object.assign({}, data, { source: override.path })
          })
        }
        if (data.suborgteams) {
          const promises = data.suborgteams.map((teamslug) => {
            return this.getReposForTeam(teamslug)
          })
          const res = await Promise.all(promises)
          res.forEach(r => {
            r.forEach(e => {
              this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, e.name, data)
            })
          })
        }
        if (data.suborgproperties) {
          const promises = data.suborgproperties.map((customProperty) => {
            return this.getReposForCustomProperty(customProperty)
          })
          const res = await Promise.all(promises)
          res.forEach(r => {
            r.forEach(e => {
              this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, e.repository_name, data)
            })
          })
        }
      }

      // If this was result of a suborg config change, only return the repos that are part of the suborg config
      if (this.subOrgConfigMap) {
        this.log.debug(`SubOrg config was changed and the associated overridePaths is = ${JSON.stringify(this.subOrgConfigMap)}`)
        // enumerate the properties of the subOrgConfigs object and delete the ones that are not part of the suborg
        for (const [key, value] of Object.entries(subOrgConfigs)) {
          if (!this.subOrgConfigMap.some((overridePath) => {
            return overridePath.path === value.source
          }
          )) {
            delete subOrgConfigs[key]
          }
        }
      }
      return subOrgConfigs
    } catch (e) {
      if (this.nop) {
        const nopcommand = new NopCommand('getSubOrgConfigs', this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.resultHandler.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  storeSubOrgConfigIfNoConflicts (subOrgConfigs, overridePath, repoName, data) {
    const existingConfigForRepo = subOrgConfigs[repoName]
    if (existingConfigForRepo && existingConfigForRepo.source !== overridePath) {
      throw new Error(`Multiple suborg configs for ${repoName} in ${overridePath} and ${existingConfigForRepo?.source}`)
    }
    subOrgConfigs[repoName] = Object.assign({}, data, { source: overridePath })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @return The parsed YAML file
   */
  async loadYaml (filePath) {
    try {
      const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
      const params = Object.assign(repo, { path: filePath, ref: this.ref })
      const response = await this.github.repos.getContent(params).catch(e => {
        this.log.error(`Error getting settings ${e}`)
      })

      // Ignore in case path is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        return null
      }

      // we don't handle symlinks or submodule
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-symlink
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-submodule
      if (typeof response.data.content !== 'string') {
        return
      }
      const yaml = require('js-yaml')
      return yaml.load(Buffer.from(response.data.content, 'base64').toString()) || {}
    } catch (e) {
      if (e.status === 404) {
        return null
      }
      if (this.nop) {
        const nopcommand = new NopCommand(filePath, this.repo, null, `${e}`, 'ERROR')
        this.log.error(`NOPCOMMAND ${JSON.stringify(nopcommand)}`)
        this.resultHandler.appendToResults([nopcommand])
        // throw e
      } else {
        throw e
      }
    }
  }

  async getReposForTeam (teamslug) {
    const options = this.github.rest.teams.listReposInOrg.endpoint.merge({
      org: this.repo.owner,
      team_slug: teamslug,
      per_page: 100
    })
    return this.github.paginate(options)
  }

  async getReposForCustomProperty (customPropertyTuple) {
    const name = Object.keys(customPropertyTuple)[0]
    let q = `props.${name}:${customPropertyTuple[name]}`
    q = encodeURIComponent(q)
    const options = this.github.request.endpoint((`/orgs/${this.repo.owner}/properties/values?repository_query=${q}`))
    return this.github.paginate(options)
  }

  isObject (item) {
    return (item && typeof item === 'object' && !Array.isArray(item))
  }

  isIterable (obj) {
    // checks for null and undefined
    if (obj == null) {
      return false
    }
    return typeof obj[Symbol.iterator] === 'function'
  }
}

Settings.FILE_NAME = path.posix.join(CONFIG_PATH, env.SETTINGS_FILE_PATH)

Settings.PLUGINS = {
  repository: require('./plugins/repository'),
  labels: require('./plugins/labels'),
  collaborators: require('./plugins/collaborators'),
  teams: require('./plugins/teams'),
  milestones: require('./plugins/milestones'),
  branches: require('./plugins/branches'),
  autolinks: require('./plugins/autolinks'),
  validator: require('./plugins/validator'),
  rulesets: require('./plugins/rulesets'),
  environments: require('./plugins/environments'),
  custom_properties: require('./plugins/custom_properties.js')
}

module.exports = Settings
