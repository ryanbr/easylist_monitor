const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// EasyList URLs to monitor
const EASYLIST_URLS = {
  'easylist.txt': 'https://easylist.to/easylist/easylist.txt',
  'easyprivacy.txt': 'https://easylist.to/easylist/easyprivacy.txt'
};

class EasyListMonitor {
  constructor() {
    this.listsDir = path.join(__dirname, 'lists');
    this.hashesFile = path.join(__dirname, 'hashes.json');
    this.metadataFile = path.join(__dirname, 'metadata.json');
  }

  async init() {
    // Ensure lists directory exists
    try {
      await fs.mkdir(this.listsDir, { recursive: true });
    } catch (error) {
      console.log('Lists directory already exists');
    }
  }

  async loadHashes() {
    try {
      const hashData = await fs.readFile(this.hashesFile, 'utf8');
      return JSON.parse(hashData);
    } catch (error) {
      console.log('No existing hashes file found, will create new one');
      return {};
    }
  }

  async saveHashes(hashes) {
    await fs.writeFile(this.hashesFile, JSON.stringify(hashes, null, 2));
  }

  async loadMetadata() {
    try {
      const data = await fs.readFile(this.metadataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return {};
    }
  }

  async saveMetadata(metadata) {
    await fs.writeFile(this.metadataFile, JSON.stringify(metadata, null, 2));
  }

  calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async fetchList(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // Extract server headers for age detection
      const headers = {
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
        contentLength: response.headers.get('content-length'),
        cacheControl: response.headers.get('cache-control')
      };
      
      const content = await response.text();
      
      return { content, headers };
    } catch (error) {
      console.error(`Failed to fetch ${url}:`, error.message);
      throw error;
    }
  }

  extractVersion(content) {
    // Extract version from EasyList header comments
    const versionMatch = content.match(/^! Version: (.+)$/m);
    const lastModifiedMatch = content.match(/^! Last modified: (.+)$/m);
    const expiresMatch = content.match(/^! Expires: (.+)$/m);
    
    return {
      version: versionMatch ? versionMatch[1] : null,
      lastModified: lastModifiedMatch ? lastModifiedMatch[1] : null,
      expires: expiresMatch ? expiresMatch[1] : null
    };
  }

  parseLastModified(lastModifiedHeader, listContent) {
    let serverTime = null;
    let contentTime = null;
    
    // Parse HTTP Last-Modified header
    if (lastModifiedHeader) {
      serverTime = new Date(lastModifiedHeader);
    }
    
    // Parse EasyList "Last modified" from content
    const contentMatch = listContent.match(/^! Last modified: (.+)$/m);
    if (contentMatch) {
      contentTime = new Date(contentMatch[1]);
    }
    
    // Use the more recent time, or fall back to available one
    if (serverTime && contentTime) {
      return serverTime > contentTime ? serverTime : contentTime;
    }
    
    return serverTime || contentTime || new Date();
  }

  isFileStale(lastModified, checkInterval = 1) {
    // Check if file is older than specified hours
    const now = new Date();
    const ageInHours = (now - lastModified) / (1000 * 60 * 60);
    return ageInHours > checkInterval;
  }

  async checkForUpdates() {
    await this.init();
    
    const currentHashes = await this.loadHashes();
    const currentMetadata = await this.loadMetadata();
    const updatedLists = [];
    const newHashes = { ...currentHashes };
    const newMetadata = { ...currentMetadata };
    
    console.log(`🔍 Checking ${Object.keys(EASYLIST_URLS).length} EasyList files for updates...`);
    
    for (const [filename, url] of Object.entries(EASYLIST_URLS)) {
      try {
        console.log(`📥 Fetching ${filename}...`);
        
        // Check if we should even fetch based on age
        const oldMetadata = currentMetadata[filename];
        if (oldMetadata && oldMetadata.lastChecked) {
          const lastChecked = new Date(oldMetadata.lastChecked);
          const minutesSinceCheck = (new Date() - lastChecked) / (1000 * 60);
          
          if (minutesSinceCheck < 90) { // Less than 90 minutes since last check
            console.log(`⏰ ${filename} was checked ${minutesSinceCheck.toFixed(0)} minutes ago (waiting for 90-minute interval)`);
            continue;
          }
        }
        
        const { content, headers } = await this.fetchList(url);
        const newHash = this.calculateHash(content);
        const versionInfo = this.extractVersion(content);
        const lastModified = this.parseLastModified(headers.lastModified, content);
        
        const oldHash = currentHashes[filename];
        
        // Multiple change detection methods
        let hasChanged = false;
        let changeReason = '';
        
        // Method 1: Hash comparison (most reliable)
        if (oldHash !== newHash) {
          hasChanged = true;
          changeReason = 'content hash changed';
        }
        
        // Method 2: Last modified time comparison
        if (oldMetadata && oldMetadata.lastModified) {
          const oldTime = new Date(oldMetadata.lastModified);
          if (lastModified > oldTime) {
            hasChanged = true;
            changeReason += (changeReason ? ' and ' : '') + 'timestamp newer';
          }
        }
        
        // Method 3: ETag comparison (if available)
        if (headers.etag && oldMetadata && oldMetadata.etag) {
          if (headers.etag !== oldMetadata.etag) {
            hasChanged = true;
            changeReason += (changeReason ? ' and ' : '') + 'ETag changed';
          }
        }
        
        if (hasChanged || !oldHash) {
          console.log(`✅ ${filename} has been updated! (${changeReason || 'first time'})`);
          console.log(`   Version: ${versionInfo.version || 'N/A'}`);
          console.log(`   Last Modified: ${lastModified.toISOString()}`);
          console.log(`   Server Last-Modified: ${headers.lastModified || 'N/A'}`);
          console.log(`   ETag: ${headers.etag || 'N/A'}`);
          console.log(`   File Age: ${((new Date() - lastModified) / (1000 * 60 * 60)).toFixed(1)} hours`);
          
          // Save the updated list
          const filepath = path.join(this.listsDir, filename);
          await fs.writeFile(filepath, content);
          
          updatedLists.push({
            filename,
            url,
            hash: newHash,
            version: versionInfo.version,
            lastModified: lastModified.toISOString(),
            serverLastModified: headers.lastModified,
            etag: headers.etag,
            size: content.length,
            changeReason,
            expires: versionInfo.expires,
            ageHours: ((new Date() - lastModified) / (1000 * 60 * 60)).toFixed(1)
          });
          
          newHashes[filename] = newHash;
          newMetadata[filename] = {
            lastModified: lastModified.toISOString(),
            etag: headers.etag,
            version: versionInfo.version,
            lastChecked: new Date().toISOString(),
            size: content.length
          };
        } else {
          const ageHours = oldMetadata && oldMetadata.lastModified 
            ? ((new Date() - new Date(oldMetadata.lastModified)) / (1000 * 60 * 60)).toFixed(1)
            : 'unknown';
          console.log(`📄 ${filename} is up to date (age: ${ageHours} hours)`);
          
          // Update last checked time even if no changes
          if (oldMetadata) {
            newMetadata[filename] = {
              ...oldMetadata,
              lastChecked: new Date().toISOString()
            };
          }
        }
        
        // Small delay between requests to be respectful
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`❌ Error processing ${filename}:`, error.message);
      }
    }
    
    if (updatedLists.length > 0) {
      await this.saveHashes(newHashes);
      await this.saveMetadata(newMetadata);
      console.log(`\n🎉 ${updatedLists.length} list(s) updated successfully!`);
      
      // Create summary for GitHub Actions
      const summary = {
        updated: updatedLists.length,
        timestamp: new Date().toISOString(),
        lists: updatedLists
      };
      
      await fs.writeFile(
        path.join(__dirname, 'update-summary.json'),
        JSON.stringify(summary, null, 2)
      );
      
      return { hasUpdates: true, updatedLists, summary };
    } else {
      console.log('\n📋 All lists are up to date');
      await this.saveMetadata(newMetadata); // Save updated check times
      return { hasUpdates: false, updatedLists: [], summary: null };
    }
  }

  async generateCommitMessage(updatedLists) {
    if (updatedLists.length === 1) {
      const list = updatedLists[0];
      return `Update ${list.filename}${list.version ? ` to v${list.version}` : ''}`;
    } else {
      return `Update ${updatedLists.length} EasyList files\n\n${updatedLists.map(list => 
        `- ${list.filename}${list.version ? ` (v${list.version})` : ''}`
      ).join('\n')}`;
    }
  }
}

// Main execution
async function main() {
  const monitor = new EasyListMonitor();
  
  try {
    const result = await monitor.checkForUpdates();
    
    if (result.hasUpdates) {
      const commitMessage = await monitor.generateCommitMessage(result.updatedLists);
      
      // Set GitHub Actions outputs
      if (process.env.GITHUB_ACTIONS) {
        const core = require('@actions/core');
        core.setOutput('has_updates', 'true');
        core.setOutput('commit_message', commitMessage);
        core.setOutput('updated_count', result.updatedLists.length.toString());
      }
      
      console.log('\n📝 Suggested commit message:');
      console.log(commitMessage);
      
      process.exit(0); // Success with updates
    } else {
      if (process.env.GITHUB_ACTIONS) {
        const core = require('@actions/core');
        core.setOutput('has_updates', 'false');
        core.setOutput('commit_message', '');
        core.setOutput('updated_count', '0');
      }
      
      process.exit(0); // Success, no updates
    }
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { EasyListMonitor };
