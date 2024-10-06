const path = require('path')
const Glob = require('./glob')
const NopCommand = require('./nopcommand')
const MergeDeep = require('./mergeDeep')
const Archive = require('./plugins/archive')
const ResultHandler = require('./resultHandler')
const env = require('./env')
const CONFIG_PATH = env.CONFIG_PATH
const SCOPE = { ORG: 'org', REPO: 'repo' } // Determine if the setting is a org setting or repo setting
/** @import { Context } from "probot" */

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

  /**
   * @param {boolean} nop
   * @param {Context} context
   * @param {{owner: string; repo: string; }} repo
   * @param {any} config The parsed contents of the main config file
   * @param {string} [ref] The ref we are reading content from, if not the default branch
   * @param {any} [suborg] The parsed contents of a suborg config file
   */
  constructor (nop, context, repo, config, ref, suborg) {
    this.ref = ref
    this.context = context
    this.installation_id = context.payload.installation.id
    this.github = context.octokit
    this.repo = repo
    this.config = config
    this.nop = nop
    /** If this instance of `Settings` was created due to changes in a suborg-file, this contains the config from that file. \
     * If suborg config has been updated, do not load the all suborg configs, and only process repos restricted to it. */
    this.changedSuborg = suborg
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

  /**
   * Used to store loaded suborg or repo configs.
   * - The key is usually the name of a repo, but it might also a glob-pattern (for the key `suborgrepos` in a suborg config file). The filenames of the config files are also added as keys.
   * - The value is the config loaded from a yaml-file.
   * @typedef {{ [repoNameOrGlobPattern: string]: { [propertyFromConfig: string]: any; } }} ConfigMap
   */
  /**
   * Load all config files for suborgs and repos
   * @param {{ repo: string }} [repo] Supply the repo object to only load config for a single repo
   */
  async loadConfigs (repo) {
    /** Mapping from repo name to suborg config.
     * - The key is usually the name of a repo, but it might also a glob-pattern (for the key `suborgrepos` in a suborg config file). The filenames of the config files are also added as keys.
     * - The value is the config loaded from a yaml-file.
    */
    this.subOrgConfigs = await this.getSubOrgConfigs()
    /** Mapping from repo name to repo config.
     * - The key is the name of the repo (which is also the name of the config file).
     * - The value is the config loaded from a yaml-file.
    */
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
    if (this.changedSuborg && !subOrgConfig) {
      this.log.debug(`Skipping... SubOrg config changed but this repo is not part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.changedSuborg)}`)
      return
    }

    this.log.debug(`Process normally... Not a SubOrg config change or SubOrg config was changed and this repo is part of it. ${JSON.stringify(repo)} suborg config ${JSON.stringify(this.changedSuborg)}`)

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

  /**
   * Get the suborg config that applies to the given repo (if applicable)
   * @param {string} repoName Name of the repo to find a matching config for
   * @returns {any|undefined} Undefined if no match, otherwise the suborg-level config to apply for this repo (if merging is implemented, this should be the merged config that applies?)
   */
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

  /** Information about a file that overrides the basic config (i.e. files in the `suborgs` or `repo` folders)
   * @typedef {Object} ConfigOverride
   * @property {string} name Name of the file
   * @property {string} path Path of the file
   */
  /**
   * Loads the path of all suborg configs from GitHub
   *
   * @param params Params to fetch the path with
   * @returns {Promise<ConfigOverride[]>} All the matching paths
   */
  async getSubOrgConfigMap () {
    this.log.debug(` In getSubOrgConfigMap ${JSON.stringify(this.repo)}`)
    const repo = { owner: this.repo.owner, repo: env.ADMIN_REPO }
    const params = Object.assign(repo, { path: path.posix.join(CONFIG_PATH, 'suborgs'), ref: this.ref })
    try {
      this.log.debug(` In loadConfigMap ${JSON.stringify(params)}`)
      const response = await this.github.repos.getContent(params).catch(e => {
        this.log.debug(`Error getting settings ${JSON.stringify(params)} ${e}`)
      })

      if (!response) {
        return []
      }
      // Return an array of values if response is a folder
      // - https://developer.github.com/v3/repos/contents/#response-if-content-is-a-directory
      if (Array.isArray(response.data)) {
        return response.data.map(d => { return { name: d.name, path: d.path } })
      } else {
        // This function is only called to load paths to suborgconfigs. The caller expects an array. If we did not match a folder, return an empty array.
        return []
      }
    } catch (e) {
      if (e.status === 404) {
        return []
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
   * Loads the path of all repo configs from GitHub
   *
   * @returns {Promise<ConfigOverride[]>} All the matching paths
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
      /** @type {ConfigOverride[]} */
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

  /** Read repo config files and store them in a ConfigMap
   * - If repo param is null and this is not a suborg change, load configs for all repos
   * - If repo param is null and this is a suborg change, load configs only for repos that are part of that suborg
   * - If repo param is not null, load the config for a specific repo
   * @param {{ repo: string }} [repo]
   * @returns {Promise<ConfigMap>} The map from reponames to repo configs
   */
  async getRepoConfigs (repo) {
    try {
      const overridePaths = await this.getRepoConfigMap()
      /** @type {ConfigMap} */
      const repoConfigs = {}

      for (const override of overridePaths) {
        // Don't load if already loaded
        if (repoConfigs[override.name]) {
          continue
        }
        // If repo is passed get only its config-file,
        // else load all the config-files
        if (repo) {
          if (override.name === `${repo.repo}.yml`) {
            const data = await this.loadYaml(override.path)
            this.log.debug(`data = ${JSON.stringify(data)}`)
            repoConfigs[override.name] = data
          }
        } else if (this.changedSuborg) {
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

  /** Read suborg config files and store them in a ConfigMap
   * @returns {Promise<ConfigMap>} The map from reponames (or globs) to suborg configs
   */
  async getSubOrgConfigs () {
    try {
      // Get all suborg configs even though we might be here becuase of a suborg config change
      // we will filter them out if request is due to a suborg config change
      const overridePaths = await this.getSubOrgConfigMap()
      /** The path of the loaded yaml-file is stored in the `source`-property.
       * @type {ConfigMap & { [repoNameOrGlobPattern: string]: { source?: string } }} */
      const subOrgConfigs = {}

      for (const override of overridePaths) {
        const data = await this.loadYaml(override.path)
        this.log.debug(`data = ${JSON.stringify(data)}`)

        if (!data) { return subOrgConfigs }

        subOrgConfigs[override.name] = data
        if (data.suborgrepos) {
          data.suborgrepos.forEach(repoNameOrGlob => {
            this.storeSubOrgConfigIfNoConflicts(subOrgConfigs, override.path, repoNameOrGlob, data)

            // In case support for multiple suborg configs for the same repo is required, merge the configs.
            //
            // Planned for the future to support multiple suborgrepos for the same repo
            //
            // if (existingConfigForRepo) {
            //   subOrgConfigs[repository] = this.mergeDeep.mergeDeep({}, existingConfigForRepo, data)
            // } else {
            //   subOrgConfigs[repository] = data
            // }

            subOrgConfigs[repoNameOrGlob] = Object.assign({}, data, { source: override.path })
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

      // If this was result of a suborg config change, only return "repo-keys" where the changed suborg config affects this "repo-key"
      if (this.changedSuborg) {
        this.log.debug(`SubOrg config was changed and the associated overridePaths is = ${JSON.stringify(this.changedSuborg)}`)
        // enumerate the properties of the subOrgConfigs object and delete the ones that doesn't have the path of the changed suborg as it's source
        for (const [key, value] of Object.entries(subOrgConfigs)) {
          if (this.changedSuborg.path !== value.source) {
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

  /**
   * Add a "repo-key" to the `subOrgConfigs` object, unless this would lead to one repo matching multiple suborg configs. \
   * Also stores the path to the config file in the `source` property of the value.
   * @param {ConfigMap} subOrgConfigs The config object we will update (if no conflict)
   * @param {string} overridePath The path to the suborg config (i.e. the file that overrides the default config)
   * @param {string} repoNameOrGlob The name or glob-pattern of repos that this would affect
   * @param {any} data The actual config to add
   */
  storeSubOrgConfigIfNoConflicts (subOrgConfigs, overridePath, repoNameOrGlob, data) {
    const existingConfigForRepo = subOrgConfigs[repoNameOrGlob]
    if (existingConfigForRepo && existingConfigForRepo.source !== overridePath) {
      throw new Error(`Multiple suborg configs for ${repoNameOrGlob} in ${overridePath} and ${existingConfigForRepo?.source}`)
    }
    subOrgConfigs[repoNameOrGlob] = Object.assign({}, data, { source: overridePath })
  }

  /**
   * Loads a file from GitHub
   *
   * @param params Params to fetch the file with
   * @returns {Promise<any>} The parsed YAML file
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
