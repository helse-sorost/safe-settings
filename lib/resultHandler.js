const path = require('path')
const { Eta } = require('eta')
const commetMessageTemplate = require('./commentmessage')
const errorTemplate = require('./error')
const env = require('./env')
const eta = new Eta({ views: path.join(__dirname) })

class ResultHandler {

    constructor(nop, context, repo) {
        this.context = context
        this.github = context.octokit
        this.repo = repo
        this.nop = nop
        this.log = context.log
        this.results = []
    }

    appendToResults(res) {
        if (this.nop) {
            //Remove nulls and undefined from the results
            const results = res.flat(3).filter(r => r)

            this.results = this.results.concat(results)
        }
    }

    async handleResults(errors) {
        const { payload } = this.context

        // Create a checkrun if not in nop mode
        if (!this.nop) {
            this.log.debug('Not run in nop')
            await this.createCheckRun(errors)
            return
        }

        // remove duplicate rows in this.results
        this.results = this.results.filter((thing, index, self) => {
            return index === self.findIndex((t) => {
                return t.type === thing.type && t.repo === thing.repo && t.plugin === thing.plugin
            })
        })

        let error = false
        // Different logic
        const stats = {
            // noOfReposProcessed: new Map(),
            reposProcessed: {},
            changes: {},
            errors: {}
        }
        /*
        Result fields
        res.type
        res.plugin
        res.repo
        res.endpoint
        res.body
        res.action
        */
        this.results.forEach(res => {
            if (res) {
                stats.reposProcessed[res.repo] = true
                // if (res.action.additions === null && res.action.deletions === null && res.action.modifications === null) {
                //   // No changes
                // } else
                if (res.type === 'ERROR') {
                    error = true
                    if (!stats.errors[res.repo]) {
                        stats.errors[res.repo] = []
                    }
                    stats.errors[res.repo].push(res.action)
                } else if (!(res.action?.additions === null && res.action?.deletions === null && res.action?.modifications === null)) {
                    if (!stats.changes[res.plugin]) {
                        stats.changes[res.plugin] = {}
                    }
                    if (!stats.changes[res.plugin][res.repo]) {
                        stats.changes[res.plugin][res.repo] = []
                    }
                    stats.changes[res.plugin][res.repo].push(`${res.action}`)
                }
            }
        })

        this.log.debug(`Stats ${JSON.stringify(this.results, null, 2)}`)

        const table = `<table>
        <thead>
        <tr>
        <th>Msg</th>
        <th>Plugin</th>
        <th>Repo</th>
        <th>Additions</th>
        <th>Deletions</th>
        <th>Modifications </th>
        </tr>
        </thead>
        <tbody>
        `

        const renderedCommentMessage = await eta.renderString(commetMessageTemplate, stats)

        if (env.CREATE_PR_COMMENT === 'true') {
            const summary = `
    #### :robot: Safe-Settings config changes detected:

    ${this.results.reduce((x, y) => {
                if (!y) {
                    return x
                }
                if (y.type === 'ERROR') {
                    error = true
                    return `${x}
    <tr><td> ❗ ${y.action.msg} </td><td> ${y.plugin} </td><td> ${prettify(y.repo)} </td><td> ${prettify(y.action.additions)} </td><td> ${prettify(y.action.deletions)} </td><td> ${prettify(y.action.modifications)} </td><tr>`
                } else if (y.action.additions === null && y.action.deletions === null && y.action.modifications === null) {
                    return `${x}`
                } else {
                    if (y.action === undefined) {
                        return `${x}`
                    }
                    return `${x}
    <tr><td> ✋ </td><td> ${y.plugin} </td><td> ${prettify(y.repo)} </td><td> ${prettify(y.action.additions)} </td><td> ${prettify(y.action.deletions)} </td><td> ${prettify(y.action.modifications)} </td><tr>`
                }
            }, table)}
    `

            const pullRequest = payload.check_run.check_suite.pull_requests[0]

            await this.github.issues.createComment({
                owner: payload.repository.owner.login,
                repo: payload.repository.name,
                issue_number: pullRequest.number,
                body: summary.length > 55536 ? `${summary.substring(0, 55536)}... (too many changes to report)` : summary
            })
        }

        const params = {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            check_run_id: payload.check_run.id,
            status: 'completed',
            conclusion: error ? 'failure' : 'success',
            completed_at: new Date().toISOString(),
            output: {
                title: error ? 'Safe-Settings Dry-Run Finished with Error' : 'Safe-Settings Dry-Run Finished with success',
                summary: renderedCommentMessage.length > 55536 ? `${renderedCommentMessage.substring(0, 55536)}... (too many changes to report)` : renderedCommentMessage
            }
        }

        this.log.debug(`Completing check run ${JSON.stringify(params)}`)
        await this.github.checks.update(params)
    }

    // Create a check in the Admin repo for safe-settings.
    async createCheckRun(errors) {
        const startTime = new Date()
        let conclusion = 'success'
        let details = `Run on: \`${new Date().toISOString()}\``
        let summary = 'Safe-Settings finished successfully.'

        if (errors.length > 0) {
            conclusion = 'failure'
            summary = 'Safe-Settings finished with errors.'
            details = await eta.renderString(errorTemplate, errors)
        }

        // Use the latest commit to create the check against
        return this.github.repos.listCommits({
            owner: this.repo.owner,
            repo: env.ADMIN_REPO
        })
            .then(commits => {
                return this.github.checks.create(
                    {
                        owner: this.repo.owner,
                        repo: env.ADMIN_REPO,
                        name: 'Safe-Settings',
                        head_sha: commits.data[0].sha,
                        status: 'completed',
                        started_at: startTime,
                        conclusion,
                        completed_at: new Date(),
                        output: {
                            title: 'Safe-Settings',
                            summary,
                            text: details.length > 55536 ? `${details.substring(0, 55536)}... (too many changes to report)` : details
                        }
                    }
                )
            })
            .then(res => {
                this.log.debug(`Created the check for Safe-Settings ${JSON.stringify(res)}`)
            }).catch(e => {
                if (e.status === 404) {
                    this.log.error('Admin Repo Not found')
                }
                this.log.error(`Check for Safe-Settings failed with ${JSON.stringify(e)}`)
            })
    }
}

function prettify(obj) {
    if (obj === null || obj === undefined) {
        return ''
    }
    return JSON.stringify(obj, null, 2).replaceAll('\n', '<br>').replaceAll(' ', '&nbsp;')
}

module.exports = ResultHandler
