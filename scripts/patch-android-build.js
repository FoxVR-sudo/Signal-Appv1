const fs = require("fs");
const path = require("path");

const appDir = process.argv[2];

if (!appDir) {
  console.error("Usage: node scripts/patch-android-build.js <app-directory>");
  process.exit(1);
}

const buildGradlePath = path.join(appDir, "android", "app", "build.gradle");
const manifestPath = path.join(appDir, "android", "app", "src", "main", "AndroidManifest.xml");
const marker = "// Signal App APK patch";

if (!fs.existsSync(buildGradlePath)) {
  console.error(`build.gradle not found: ${buildGradlePath}`);
  process.exit(1);
}

const hook = `

${marker}
tasks.matching { it.name == "generateAutolinkingPackageList" }.configureEach {
    doLast {
        def packageListFile = file("$buildDir/generated/autolinking/src/main/java/com/facebook/react/PackageList.java")
        if (packageListFile.exists()) {
            def contents = packageListFile.getText("UTF-8")
            contents = contents.replace("import expo.core.ExpoModulesPackage;", "import expo.modules.ExpoModulesPackage;")
            packageListFile.write(contents, "UTF-8")
        }
    }
}
`;

const current = fs.readFileSync(buildGradlePath, "utf8");
if (!current.includes(marker)) {
  fs.writeFileSync(buildGradlePath, current + hook, "utf8");
}

if (appDir.includes("citizen-mobile") && fs.existsSync(manifestPath)) {
  const manifest = fs.readFileSync(manifestPath, "utf8");
  if (!manifest.includes("android:usesCleartextTraffic")) {
    const patchedManifest = manifest.replace(
      "<application",
      '<application android:usesCleartextTraffic="true"'
    );
    fs.writeFileSync(manifestPath, patchedManifest, "utf8");
  }
}