'use strict'

const { dom, json } = require('fs-request-cache')
const fs = require('fs')
const Parallel = require('async-parallel')
const { Parser: Json2csvParser } = require('json2csv')
const { format } = require('date-fns')
const { flat } = require('lodash')

const getSalaries = require('./get-salaries')

const HOST = 'https://www.getonbrd.cl'

const txt = el => el.text().trim()

const ttl = 3600 * 4

const months = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre'
]

const getCategories = async () => {
  const $ = await dom(`${HOST}/empleos`, { ttl })

  const ids = $('.jobs').map((i, el) => $(el).attr('id')).get()
  const links = ids.map(id => `${HOST}/empleos/${id}`)

  return links
}

const getJobs = async (url, salaryMap) => {
  const $$ = await dom(url, { ttl })
  const jobsLinks = $$('.job')
    .map((i, el) => $$(el).children('a').attr('href'))
    .get()

  const jobs = await Parallel.map(jobsLinks, async link => {
    console.log('getting job', link)
    const $ = await dom(link, { ttl })

    const _company = $('[itemprop="hiringOrganization"]')
    const company = {
      logo: _company.find('.gb-company-logo__img').attr('src'),
      name: txt(_company.find('h3 [itemprop="name"]')),
      link: _company.find('h3 a').attr('href')
    }
    const date = txt(_company.find('time'))

    const _title = $('.gb-landing-cover__title')
    const title = txt(_title.find('[itemprop="title"]'))
    const level = txt(_title.find('[itemprop="qualifications"]'))
    const type = txt($('[itemprop="employmentType"]'))

    const _loc = $('[itemprop="jobLocation"]')
    const country = txt(_loc.find('[itemprop="addressCountry"]'))
    const city = txt(_loc.find('[itemprop="addressLocality"]'))

    const _salary = $('[itemprop="baseSalary"]')
    const salary = _salary.length
      ? txt(_salary.find('strong'))
        .split(' - ')
        .map(n => n.match(/\d+/g).join(''))
        .map(Number)
      : null

    const [day, monthName, year] = date.split(' de ')
    const monthNum = months.findIndex(m => m === monthName)
    const newDate = new Date(year, monthNum, Number(day))

    const foundOnMap = salaryMap.find(j => j.url === link)
    const salaryAvg = salary
      ? salary[1] ? (salary[0] + salary[1]) / 2 : salary[0]
      : foundOnMap
        ? foundOnMap.salaryAvg
        : null

    if (salary && salary.length === 1) console.log('SALARY', salaryAvg, link)

    const job = {
      date,
      parsedDate: newDate.toISOString(),
      msDate: newDate.getTime(),
      salary: !salary ? foundOnMap ? foundOnMap.salary : null : salary,
      salaryFromMap: Boolean(!salary && foundOnMap),
      salaryAvg,
      company: company.name,
      title,
      level,
      type,
      country,
      city,
      link
    }

    console.log('got job', title)
    return job
  }, 2).catch(console.error)

  return jobs
}

const main = async () => {
  const usdClpUrl = 'http://data.fixer.io/api/latest?access_key=d52e0bc3c567f84aeaf162b15d6102c5'
  const { rates, base } = await json(usdClpUrl, { ttl })
  if (base !== 'EUR') throw Error(`Currency isn't EUR`)
  const usdClp = 1 / rates.USD * rates.CLP
  console.log('usd/clp', usdClp)

  console.log('getting salaries')
  const salaryMap = await getSalaries()

  const categories = await getCategories()
  const allJobs = await Promise.all(categories.map(async categ => {
    const jobs = await getJobs(categ, salaryMap)
    console.log('got category', categ)
    return jobs
  }))

  const months = 1000 * 3600 * 24 * 30 * 1 // last digit
  const dateFilter = j => j.msDate > Date.now() - months

  const filtered = flat(allJobs
    .filter(j => j.salaryAvg && dateFilter(j))
    .sort((a, b) => b.salaryAvg - a.salaryAvg)
    .map(j => ({
      ...j,
      salaryAvg: Math.round(j.salaryAvg * usdClp),
      msDate: undefined,
      parsedDate: undefined
    }))
    .filter(j => j.salaryAvg > 500000)
  )

  try {
    const parser = new Json2csvParser({ withBOM: true })
    const csv = parser.parse(JSON.parse(JSON.stringify(filtered)))
    const date = format(new Date(), 'YYYY-MM-DD')

    fs.writeFileSync(`jobs-latest.csv`, csv)
    fs.writeFileSync(`./snapshots/jobs-${date}.csv`, csv)
  } catch (err) {
    console.error(err)
  }
}

main()
