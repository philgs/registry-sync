const _ = require('lodash')
const Bacon = require('baconjs')
const crypto = require('crypto')
const fs = require('fs')
const mkdirp = require('mkdirp')
const path = require('path')
const request = require('request')
const semver = require('semver')
const url = require('url')
const readdirp = require('readdirp')

const responseCache = {}
const requiredFiles = {}

function synchronize(options) {

  function sha1(data) {
    return crypto.createHash('sha1').update(data).digest('hex')
  }

  function fetchUrl(url, bodyIsBinary) {
    if (responseCache[url]) {
      return Bacon.later(0, responseCache[url])
    }

    return Bacon.fromNodeCallback(callback => {
      request(url, {timeout: 20000, encoding: bodyIsBinary ? null : undefined},
        (error, response, body) => {
          if (!error && response.statusCode == 200) {
            if (!url.endsWith('.tgz')) {
              responseCache[url] = body
            }
            callback(null, body)
          } else {
            const statusCode = response ? response.statusCode : 'n/a'
            callback(`Failed to fetch ${url} because of error '${error}' and/or HTTP status ${statusCode}`)
          }
        }
      )
    })
  }

  function encodeScopedPackage(name) {
    return name.replace("\/", "%2f");
  }

  function fetchMetadata(name) {
    return fetchUrl(url.resolve(options.registryUrl, encodeScopedPackage(name))).map(JSON.parse)
  }

  function fetchVersionMetadata(name, version) {
    return fetchUrl(url.resolve(options.registryUrl, encodeScopedPackage(name) + '/' + version)).map(JSON.parse)
  }

  function fetchTarball(dist) {
    return fetchUrl(dist.tarball, true)
  }

  function fetchPrebuiltBinary(name, version, binaryMetadata, abi, platform, arch) {
    return fetchUrl(prebuiltBinaryUrl(name, version, binaryMetadata, abi, platform, arch), true)
  }

  function dependenciesToArray(dependencies) {
    return Object.keys(dependencies || {}).map(key => {
      return {
        name: key,
        versionRange: dependencies[key]
      }
    })
  }

  function packageFilename(name, version) {
    return encodeScopedPackage(name) + '-' + version + '.tgz'
  }

  function packageMetadataFilePath(name) {
    mkdirp.sync(path.resolve(options.rootFolder, encodeScopedPackage(name)))
    return path.resolve(options.rootFolder, encodeScopedPackage(name) + '/index.json')
  }

  function packageTarballFilePath(name, version) {
    return path.resolve(options.rootFolder, encodeScopedPackage(name) + '/' + packageFilename(name, version))
  }

  function packageTarballFileUrl(name, version) {
    return url.resolve(options.localUrl, encodeScopedPackage(name) + '/' + packageFilename(name, version))
  }

  const collectedPackages = {}

  function collectPackage(package) {
    const versions = collectedPackages[package.name] || []
    if (versions.indexOf(package.version) != -1) {
      return false
    }
    versions.push(package.version)
    collectedPackages[package.name] = versions
    return true
  }

  function collectedPackagesAsArray() {
    return Object.keys(collectedPackages).map(name => {
        return {
          name: name,
          versions: collectedPackages[name]
        }
      }
    )
  }

  function resolveVersionAndDependencies(package) {
    return fetchMetadata(package.name)
      .map(metadata => {
          const available = Object.keys(metadata.versions)
          const version = semver.maxSatisfying(available, package.versionRange)
          return {
            name: package.name,
            version: version,
            dependencies: dependenciesToArray(metadata.versions[version].dependencies)
          }
        }
      )
      .flatMap(packageAndDependencies => {
        if (collectPackage(packageAndDependencies)) {
          return Bacon.fromArray(packageAndDependencies.dependencies).flatMapConcat(resolveVersionAndDependencies)
        }
        return Bacon.never()
      })
  }

  function fileExists(file) {
    requiredFiles[file] = true
    return fs.existsSync(file)
  }

  function tarballExists(distribution) {
    return fileExists(packageTarballFilePath(distribution.name, distribution.version))
  }

  // see node-pre-gyp: /lib/util/versioning.js for documentation of possible values
  function formatPrebuilt(formatString, name, version, moduleName, abi, platform, arch) {
    const moduleVersion = semver.parse(version)
    const prerelease = moduleVersion.prerelease.length ? moduleVersion.prerelease.join('.') : ''
    const build = moduleVersion.build.length ? moduleVersion.build.join('.') : ''

    return formatString
      .replace('{name}', encodeScopedPackage(name))
      .replace('{version}', version)
      .replace('{major}', moduleVersion.major)
      .replace('{minor}', moduleVersion.minor)
      .replace('{patch}', moduleVersion.patch)
      .replace('{prerelease}', prerelease)
      .replace('{build}', build)
      .replace('{module_name}', moduleName)
      .replace('{node_abi}', 'node-v' + abi)
      .replace('{platform}', platform)
      .replace('{arch}', arch)
      .replace('{configuration}', 'Release')
      .replace('{toolset}', '')
  }

  function prebuiltBinaryExists(name, version, binaryMetadata, abi, platform, arch) {
    return fileExists(prebuiltBinaryFilePath(name, version, binaryMetadata, abi, platform, arch))
  }

  function prebuiltBinaryFilePath(name, version, binaryMetadata, abi, platform, arch) {
    return path.resolve(options.rootFolder, encodeScopedPackage(name) + '/' + prebuiltBinaryFileName(name, version, binaryMetadata, abi, platform, arch))
  }

  function prebuiltBinaryRemotePath(name, version, binaryMetadata, abi, platform, arch) {
    return formatPrebuilt(binaryMetadata['remote_path'], name, version, binaryMetadata['module_name'], abi, platform, arch).replace(/[\/]+/g, '/')
  }

  function prebuiltBinaryFileName(name, version, binaryMetadata, abi, platform, arch) {
    return formatPrebuilt(binaryMetadata['package_name'], name, version, binaryMetadata['module_name'], abi, platform, arch).replace(/[\/]+/g, '/')
  }

  function prebuiltBinaryUrl(name, version, binaryMetadata, abi, platform, arch) {
    const remotePath = prebuiltBinaryRemotePath(name, version, binaryMetadata, abi, platform, arch)
    const fileName = prebuiltBinaryFileName(name, version, binaryMetadata, abi, platform, arch)
    return url.resolve(binaryMetadata.host, remotePath + fileName)
  }

  function downloadPackage(nameAndVersions) {
    function cleanupMetadata(metadataContent, versions) {
      const content = _.cloneDeep(metadataContent)
      Object.keys(content.versions).forEach(version => {
        if (versions.indexOf(version) == -1) {
          delete content.versions[version]
          delete content.time[version]
        }
        else {
          content.versions[version].dist.tarball = packageTarballFileUrl(nameAndVersions.name, version)
          if (content.versions[version].binary) {
            content.versions[version].binary.host = options.localUrl
            content.versions[version].binary.remote_path = '/' + encodeScopedPackage(nameAndVersions.name) + '/'
          }
        }
      })
      return content
    }

    return fetchMetadata(nameAndVersions.name)
      .doAction(metadataContent => {
        const file = packageMetadataFilePath(nameAndVersions.name)
        const content = JSON.stringify(cleanupMetadata(metadataContent, nameAndVersions.versions), null, options.pretty ? 2 : undefined)
        if (!fileExists(file) || content != fs.readFileSync(file)) {
          fs.writeFileSync(file, content)
        }
      })
      .flatMap(metadataContent => {
        const distributions = nameAndVersions.versions.map(version => {
            return {
              name: nameAndVersions.name,
              version: version,
              dist: metadataContent.versions[version].dist,
              binary: metadataContent.versions[version].binary
            }
          }
        )
        return Bacon.fromArray(distributions)
      })
      .flatMap(distribution => {
        if (distribution.binary && distribution.binary['module_name']) {
          return Bacon.fromArray(options.prebuiltBinaryProperties)
            .flatMapConcat(properties => {
              if (prebuiltBinaryExists(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch)) {
                console.log('Already downloaded ' + prebuiltBinaryFileName(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch))
                return Bacon.once(distribution)
              }
              return fetchPrebuiltBinary(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch)
                .doAction(data => {
                  fs.writeFileSync(prebuiltBinaryFilePath(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch), data)
                  console.log('Downloaded pre-built binary ' + prebuiltBinaryUrl(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch))
                })
                .mapError(err => {
                  console.log('Pre-built binary not available ' + prebuiltBinaryUrl(distribution.name, distribution.version, distribution.binary, properties.abi, properties.platform, properties.arch))
                  return distribution
                })
                .map(distribution)
            }).skipDuplicates()
        } else {
          return Bacon.once(distribution)
        }
      })
      .flatMap(distribution => {
        if (tarballExists(distribution)) {
          return Bacon.once('Already downloaded ' + distribution.name + '@' + distribution.version)
        }
        return fetchTarball(distribution.dist)
          .doAction(data => {
            if (sha1(data) != distribution.dist.shasum) {
              throw new Error('SHA checksum of ' + distribution.name + '@' + distribution.version + ' does not match')
            }
            fs.writeFileSync(packageTarballFilePath(distribution.name, distribution.version), data)
          })
          .map('Downloaded ' + distribution.name + '@' + distribution.version)
      })
  }

  const dependencies = dependenciesToArray(require(path.resolve(options.manifest)).dependencies)
  const downloaded = Bacon.fromArray(dependencies)
    .flatMap(resolveVersionAndDependencies)
    .mapEnd(collectedPackagesAsArray)
    .flatMap(Bacon.fromArray)
    .flatMapWithConcurrencyLimit(5, downloadPackage)

  downloaded.onEnd(() => {
    if (options.prune) {
      Bacon.fromEvent(readdirp({root: options.rootFolder, entryType: 'both'}), 'data')
        .filter((entry) => {
          return !requiredFiles[entry.fullPath]
        })
        .onValue((entry) => {
          if (entry.stat.isDirectory()) {
            fs.rmdir(entry.fullPath, (err) => {
              if (!err) {
                console.log(`Removed ${entry.path}/`)
              }
            })
          } else {
            fs.unlink(entry.fullPath, (err) => {
              if (!err) {
                console.log(`Removed ${entry.path}`)
              }
            })
          }
        })
    }
  })

  downloaded.onError(err => {
    throw new Error(err)
  })
  downloaded.log()
}

module.exports = synchronize