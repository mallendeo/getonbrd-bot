'use strict'

require('dotenv').config()

const { request, dom } = require('fs-request-cache')
const qs = require('qs')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')

const adapter = new FileSync('db.json')
const db = low(adapter)
const SALARY_STEP = 50

db.defaults({ jobs: [] }).write()

const HOST = 'https://www.getonbrd.com'
const SEARCH_URL = `${HOST}/webpros/search_jobs`

const { SESSION_COOKIE } = process.env

let CSRFToken = null

const getJobsToExclude = async () => [
  ...(await getAllJobs(0)),
  ...(await getAllJobs(20000))
]

const getAllJobs = async salary => {
  const allJobs = []

  const get = async (offset = 0) => {
    const { jobs, next } = await getJobs(salary, offset)
    allJobs.push(...jobs)

    if (next) return get(offset + 25)

    return allJobs
  }

  return get()
}

const getJobs = async (salary, offset = 0, step = SALARY_STEP) => {
  if (typeof salary === 'undefined') throw Error('salary required!')

  CSRFToken =
    CSRFToken ||
    (await dom(HOST, { ttl: 3600 }, { headers: { Cookie: SESSION_COOKIE } }))(
      '[name="csrf-token"]'
    ).attr('content')

  const dataObj = {
    utf8: '✓',
    offset,
    webpro: {
      min_salary: salary - step > 0 ? salary - step : salary,
      max_salary: salary,
      remote_jobs: 0,
      tenant_ids: ['', 1, 5]
    }
  }

  const data = qs.stringify(dataObj, { arrayFormat: 'brackets' })

  console.log(dataObj)

  const res = await request(
    SEARCH_URL,
    { ttl: 3600 },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: SESSION_COOKIE,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': CSRFToken
      },
      method: 'post',
      data
    }
  )

  const htmlMatch = res.match(
    /jobs_container\.(?:html|append)\("([\s\S]+?)"\);/
  )

  const html = htmlMatch[1]
  const next = res.includes('#load-more-preferred-jobs-link')
  const re = /href=\\"(.+?)\\"/
  const jobs = html.match(RegExp(re, 'g')).map(m => m.match(re)[1])

  return {
    jobs,
    next
  }
}

const makeRange = (from = 500, to = 7000, step = SALARY_STEP) => {
  const items = []

  for (let i = from; i <= to; i += step) {
    items.push(i)
  }

  return items
}

module.exports = async () => {
  const exclude = await getJobsToExclude()
  db.set('jobs', []).write()

  const dbJobs = db.get('jobs')
  dbJobs.push(...exclude.map(j => ({ url: j, salary: null }))).write()

  console.log({ exclude })
  const salaries = makeRange()

  for (const salary of salaries) {
    const jobs = await getAllJobs(salary)
    jobs.forEach(j => {
      const found = dbJobs.find({ url: j })
      if (found.value()) {
        found
          .update('salary', s => (s !== null ? [...s, salary] : null))
          .write()
        return
      }

      dbJobs.push({ url: j, salary: [salary] }).write()
    })

    console.log({ jobs, salary })
  }

  const allJobs = dbJobs
    .value()
    .map(job => {
      const range = job.salary
        ? [Math.min(...job.salary), Math.max(...job.salary)]
        : null

      return {
        ...job,
        salary: range,
        salaryAvg: range ? Math.round((range[0] + range[1]) / 2) : null
      }
    })
    .filter(j => j.salary)
    .sort((a, b) => b.salaryAvg - a.salaryAvg)

  db.set('jobs', allJobs).write()

  return allJobs
}
